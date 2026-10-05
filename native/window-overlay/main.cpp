#include <windows.h>
#include <dwmapi.h>
#include <QApplication>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPainter>
#include <QRegularExpression>
#include <QTimer>
#include <QWidget>
#include <cmath>

namespace {
constexpr DWORD captureExcluded = 0x11;
constexpr int flashMilliseconds = 2000;
constexpr int maximumMessage = 16384;

void reply(const QJsonObject &value) {
    const QByteArray line = QJsonDocument(value).toJson(QJsonDocument::Compact) + '\n';
    DWORD written = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line.constData(), DWORD(line.size()), &written, nullptr)
        || written != DWORD(line.size())) QCoreApplication::quit();
}

bool integer(const QJsonValue &value, qint64 low, qint64 high) {
    const double number = value.toDouble(std::nan(""));
    return std::isfinite(number) && std::floor(number) == number && number >= low && number <= high;
}

// This window draws only. Native APIs here read identity/focus metadata or configure our own HWND.
class Frame final : public QWidget {
public:
    Frame() : QWidget(nullptr, Qt::Tool | Qt::FramelessWindowHint | Qt::WindowStaysOnTopHint
        | Qt::WindowTransparentForInput | Qt::WindowDoesNotAcceptFocus) {
        setAttribute(Qt::WA_TranslucentBackground);
        setAttribute(Qt::WA_ShowWithoutActivating);
        setFocusPolicy(Qt::NoFocus);
        handle = reinterpret_cast<HWND>(winId());
        const LONG_PTR styles = GetWindowLongPtrW(handle, GWL_EXSTYLE);
        SetWindowLongPtrW(handle, GWL_EXSTYLE, styles | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW);
        DWORD affinity = 0;
        excluded = SetWindowDisplayAffinity(handle, captureExcluded)
            && GetWindowDisplayAffinity(handle, &affinity) && affinity == captureExcluded;
        connect(&watch, &QTimer::timeout, this, [this] {
            if (isVisible() && (age.elapsed() >= flashMilliseconds || !sameSource())) hide();
        });
        watch.start(40);
    }

    bool ready() const { return excluded; }
    quintptr windowId() const { return reinterpret_cast<quintptr>(handle); }

    void command(const QJsonObject &message) {
        const auto number = message.value("generation");
        if (!integer(number, 1, 9007199254740991LL)) { hide(); reply({{"status", "refused"}, {"generation", 0}}); return; }
        const qint64 next = qint64(number.toDouble());
        if (next <= generation) { reply({{"status", "stale"}, {"generation", double(next)}}); return; }
        generation = next;
        hide();
        const QString kind = message.value("kind").toString();
        if (kind == "hide") { reply({{"status", "hidden"}, {"generation", double(next)}}); return; }
        const QJsonObject target = message.value("target").toObject();
        const QJsonObject bounds = message.value("bounds").toObject();
        const QString identity = message.value("identity").toString();
        const auto marker = QRegularExpression("^(PiComputerUse\\.[a-fA-F0-9]{32}):([1-9][0-9]*):([1-9][0-9]*)$").match(identity);
        if (kind != "flash" || !excluded || message.value("duration_ms").toInt() != flashMilliseconds
            || !integer(target.value("pid"), 1, MAXDWORD) || !integer(target.value("window_id"), 1, 9007199254740991LL)
            || !integer(bounds.value("x"), -2000000, 2000000) || !integer(bounds.value("y"), -2000000, 2000000)
            || !integer(bounds.value("width"), 1, 32768) || !integer(bounds.value("height"), 1, 32768)
            || !marker.hasMatch() || marker.captured(2).toULongLong() != quint64(target.value("pid").toDouble())) {
            reply({{"status", "refused"}, {"generation", double(next)}}); return;
        }
        source = reinterpret_cast<HWND>(quintptr(target.value("window_id").toDouble()));
        pid = DWORD(target.value("pid").toDouble());
        key = marker.captured(1).toStdWString();
        bool markerValid = false;
        markerValue = marker.captured(3).toULongLong(&markerValid);
        if (!markerValid || markerValue == 0 || markerValue > 9007199254740991ULL
            || !GetWindowRect(source, &original)
            || FAILED(DwmGetWindowAttribute(source, DWMWA_EXTENDED_FRAME_BOUNDS, &visibleSource, sizeof(visibleSource)))
            || !sameSource()) {
            reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "source_lifetime"}}); return;
        }
        // CUA reports DWM's visible frame, not GetWindowRect's invisible resize borders.
        if (visibleSource.left != bounds.value("x").toInt() || visibleSource.top != bounds.value("y").toInt()
            || visibleSource.right - visibleSource.left != bounds.value("width").toInt()
            || visibleSource.bottom - visibleSource.top != bounds.value("height").toInt()) {
            reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "source_geometry"},
                {"actual", QJsonObject{{"x", int(visibleSource.left)}, {"y", int(visibleSource.top)},
                    {"width", int(visibleSource.right-visibleSource.left)}, {"height", int(visibleSource.bottom-visibleSource.top)}}}, {"requested", bounds}}); return;
        }
        const HWND foreground = GetForegroundWindow();
        GUITHREADINFO focusBefore{}; focusBefore.cbSize = sizeof(focusBefore);
        const bool focusRead = GetGUIThreadInfo(0, &focusBefore);
        show();
        // Qt's public geometry uses logical pixels. Position this DPI-aware HWND in the physical CUA domain.
        const bool positioned = SetWindowPos(handle, HWND_TOPMOST, bounds.value("x").toInt(), bounds.value("y").toInt(),
            bounds.value("width").toInt(), bounds.value("height").toInt(), SWP_NOACTIVATE | SWP_SHOWWINDOW);
        DWORD affinity = 0; RECT actual{};
        GUITHREADINFO focusAfter{}; focusAfter.cbSize = sizeof(focusAfter);
        const bool focusUnchanged = focusRead && GetGUIThreadInfo(0, &focusAfter)
            && focusBefore.hwndFocus == focusAfter.hwndFocus && focusBefore.hwndActive == focusAfter.hwndActive;
        const bool correct = positioned && focusUnchanged && GetWindowRect(handle, &actual) && GetWindowDisplayAffinity(handle, &affinity)
            && affinity == captureExcluded && GetForegroundWindow() == foreground
            && actual.left == bounds.value("x").toInt() && actual.top == bounds.value("y").toInt()
            && actual.right - actual.left == bounds.value("width").toInt() && actual.bottom - actual.top == bounds.value("height").toInt();
        if (!correct) { hide(); reply({{"status", "refused"}, {"generation", double(next)}}); return; }
        age.restart(); update();
        reply({{"status", "shown"}, {"generation", double(next)}, {"overlay_hwnd", double(windowId())},
            {"capture_affinity", double(affinity)}, {"bounds", bounds}, {"focus_unchanged", focusUnchanged},
            {"foreground_unchanged", true}, {"duration_ms", flashMilliseconds}});
    }

protected:
    void paintEvent(QPaintEvent *) override {
        QPainter painter(this);
        painter.setPen(QPen(QColor(30, 200, 255, 240), 3));
        painter.setBrush(Qt::NoBrush);
        painter.drawRect(rect().adjusted(2, 2, -2, -2));
    }
    bool nativeEvent(const QByteArray &, void *message, qintptr *result) override {
        const MSG *event = static_cast<MSG *>(message);
        if (event->message == WM_MOUSEACTIVATE) { *result = MA_NOACTIVATE; return true; }
        if (event->message == WM_NCHITTEST) { *result = HTTRANSPARENT; return true; }
        return false;
    }

private:
    bool sameSource() const {
        DWORD currentPid = 0; RECT current{}; RECT visible{};
        return source && IsWindow(source) && !IsIconic(source) && GetWindowThreadProcessId(source, &currentPid)
            && currentPid == pid && reinterpret_cast<quintptr>(GetPropW(source, key.c_str())) == markerValue
            && GetWindowRect(source, &current) && EqualRect(&original, &current)
            && SUCCEEDED(DwmGetWindowAttribute(source, DWMWA_EXTENDED_FRAME_BOUNDS, &visible, sizeof(visible)))
            && EqualRect(&visibleSource, &visible);
    }
    HWND handle{}; HWND source{}; DWORD pid{}; quintptr markerValue{};
    std::wstring key; RECT original{}; RECT visibleSource{}; qint64 generation{};
    bool excluded = false;
    QTimer watch; QElapsedTimer age;
};
}

int main(int argc, char **argv) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    QApplication application(argc, argv);
    application.setQuitOnLastWindowClosed(false);
    Frame frame;
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    if (!frame.ready() || GetFileType(input) != FILE_TYPE_PIPE) {
        reply({{"status", "unavailable"}, {"generation", 0}}); return 1;
    }
    reply({{"status", "ready"}, {"generation", 0}, {"pid", double(GetCurrentProcessId())},
        {"overlay_hwnd", double(frame.windowId())}, {"qt_version", QT_VERSION_STR}, {"capture_affinity", double(captureExcluded)}});
    QByteArray pending;
    QTimer inputPoll;
    QObject::connect(&inputPoll, &QTimer::timeout, &application, [&] {
        DWORD available = 0;
        if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) { application.quit(); return; }
        if (!available) return;
        char buffer[4096]; DWORD count = 0;
        if (!ReadFile(input, buffer, qMin<DWORD>(available, sizeof(buffer)), &count, nullptr) || !count) { application.quit(); return; }
        pending.append(buffer, int(count));
        int end = -1;
        while ((end = pending.indexOf('\n')) >= 0) {
            if (end > maximumMessage) { application.quit(); return; }
            const QByteArray line = pending.left(end); pending.remove(0, end + 1);
            QJsonParseError error;
            const auto document = QJsonDocument::fromJson(line, &error);
            if (error.error != QJsonParseError::NoError || !document.isObject()) { application.quit(); return; }
            frame.command(document.object());
        }
        if (pending.size() > maximumMessage) application.quit();
    });
    inputPoll.start(20);
    return application.exec();
}
