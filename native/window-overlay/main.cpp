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
        const QJsonObject bounds = message.value("bounds").toObject();
        if (kind != "flash" || !excluded || message.value("duration_ms").toInt() != flashMilliseconds || !rectangle(bounds)) {
            reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "invalid_frame"}}); return;
        }
        physical = QRect(bounds.value("x").toInt(), bounds.value("y").toInt(), bounds.value("width").toInt(), bounds.value("height").toInt());
        display = message.value("display").toString() == "primary";
        if (display) {
            if (message.contains("target") || message.contains("identity") || !primaryBounds(&visibleSource)) {
                reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "display_geometry"}}); return;
            }
            source = nullptr;
        } else {
            const QJsonObject target = message.value("target").toObject();
            const auto marker = QRegularExpression("^(PiComputerUse\\.[a-fA-F0-9]{32}):([1-9][0-9]*):([1-9][0-9]*)$").match(message.value("identity").toString());
            if (!integer(target.value("pid"), 1, MAXDWORD) || !integer(target.value("window_id"), 1, 9007199254740991LL)
                || !marker.hasMatch() || marker.captured(2).toULongLong() != quint64(target.value("pid").toDouble())) {
                reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "source_identity"}}); return;
            }
            source = reinterpret_cast<HWND>(quintptr(target.value("window_id").toDouble()));
            pid = DWORD(target.value("pid").toDouble());
            key = marker.captured(1).toStdWString();
            bool markerValid = false;
            markerValue = marker.captured(3).toULongLong(&markerValid);
            if (!markerValid || markerValue == 0 || markerValue > 9007199254740991ULL || !GetWindowRect(source, &original)
                || FAILED(DwmGetWindowAttribute(source, DWMWA_EXTENDED_FRAME_BOUNDS, &visibleSource, sizeof(visibleSource))) || !sameSource()) {
                reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "source_lifetime"}}); return;
            }
        }
        // Window scope is CUA's DWM visible frame; display scope is the physical primary monitor.
        if (visibleSource.left != physical.x() || visibleSource.top != physical.y()
            || visibleSource.right - visibleSource.left != physical.width() || visibleSource.bottom - visibleSource.top != physical.height()) {
            reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "source_geometry"}}); return;
        }
        const QJsonObject mark = message.value("mark").toObject();
        style = mark.isEmpty() ? "overview" : mark.value("kind").toString();
        hasPoint = mark.contains("point");
        drawing = physical; point = {};
        if (style != "overview" && style != "detail" && style != "action") {
            reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "invalid_mark"}}); return;
        }
        if (style == "overview") {
            if (mark.contains("region") || hasPoint) { reply({{"status", "refused"}, {"generation", double(next)}}); return; }
        } else if (mark.contains("region") && !hasPoint) {
            const QJsonObject r = mark.value("region").toObject();
            if (!rectangle(r)) { reply({{"status", "refused"}, {"generation", double(next)}}); return; }
            drawing = QRect(r.value("x").toInt(), r.value("y").toInt(), r.value("width").toInt(), r.value("height").toInt());
            if (!physical.contains(drawing)) { reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "mark_scope"}}); return; }
        } else if (style == "action" && hasPoint && !mark.contains("region")) {
            const QJsonObject p = mark.value("point").toObject();
            if (!integer(p.value("x"), -2000000, 2000000) || !integer(p.value("y"), -2000000, 2000000)) {
                reply({{"status", "refused"}, {"generation", double(next)}}); return;
            }
            point = QPoint(p.value("x").toInt(), p.value("y").toInt());
            if (!physical.contains(point)) { reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "mark_scope"}}); return; }
        } else { reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "missing_mark_geometry"}}); return; }
        canvas = {}; // Do not paint while Qt is still negotiating the native canvas size.
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
            && actual.right - actual.left >= physical.width() && actual.bottom - actual.top >= physical.height()
            && actual.right - actual.left - physical.width() <= int(std::ceil(devicePixelRatioF())) - 1
            && actual.bottom - actual.top - physical.height() <= int(std::ceil(devicePixelRatioF())) - 1;
        if (!correct) {
            hide(); reply({{"status", "refused"}, {"generation", double(next)}, {"reason", "native_show_check"},
                {"positioned", positioned}, {"focus_unchanged", focusUnchanged}, {"foreground_unchanged", GetForegroundWindow() == foreground},
                {"capture_affinity", double(affinity)}, {"actual", QJsonObject{{"x", int(actual.left)}, {"y", int(actual.top)},
                    {"width", int(actual.right - actual.left)}, {"height", int(actual.bottom - actual.top)}}}}); return;
        }
        canvas = QSize(int(actual.right - actual.left), int(actual.bottom - actual.top));
        age.restart(); update();
        reply({{"status", "shown"}, {"generation", double(next)}, {"overlay_hwnd", double(windowId())},
            {"capture_affinity", double(affinity)}, {"bounds", bounds}, {"focus_unchanged", focusUnchanged},
            {"foreground_unchanged", true}, {"duration_ms", flashMilliseconds}, {"mark", mark}, {"style", style}});
    }

protected:
    void paintEvent(QPaintEvent *) override {
        if (canvas.isEmpty()) return;
        QPainter painter(this);
        // QWidget painting is logical-pixel based. Match the physical HWND positioned below,
        // including windows on monitors with a different DPI; never reuse desktop coordinates as Qt geometry.
        // Qt may round the helper canvas outwards by a physical pixel at fractional DPI.
        // Map painting against its actual native extent and clip to the exact source, not the overscan.
        painter.scale(double(width()) / canvas.width(), double(height()) / canvas.height());
        painter.setClipRect(QRect(0, 0, physical.width(), physical.height()));
        painter.setRenderHint(QPainter::Antialiasing);
        const QColor color = style == "action" ? QColor(255, 70, 190, 245) : style == "detail" ? QColor(255, 185, 30, 245) : QColor(30, 200, 255, 245);
        painter.setPen(QPen(color, 3));
        painter.setBrush(Qt::NoBrush);
        const QPoint offset = physical.topLeft();
        if (hasPoint) {
            const QPointF p = point - offset;
            painter.drawEllipse(p, 12, 12);
            painter.drawLine(p + QPointF(-18, 0), p + QPointF(18, 0));
            painter.drawLine(p + QPointF(0, -18), p + QPointF(0, 18));
        } else {
            painter.drawRect(QRectF(drawing.translated(-offset)).adjusted(2, 2, -2, -2));
        }
        const QPoint at = hasPoint ? point - offset + QPoint(16, 16) : drawing.topLeft() - offset + QPoint(8, 8);
        const QRectF label(qBound(4, at.x(), qMax(4, physical.width() - 140)), qBound(4, at.y(), qMax(4, physical.height() - 26)), 136, 22);
        painter.fillRect(label, QColor(15, 15, 20, 210));
        painter.drawText(label.adjusted(5, 0, -3, 0), Qt::AlignVCenter | Qt::AlignLeft, style == "action" ? "Action target" : style == "detail" ? "Zoom / crop" : "Observe");
    }
    bool nativeEvent(const QByteArray &, void *message, qintptr *result) override {
        const MSG *event = static_cast<MSG *>(message);
        if (event->message == WM_MOUSEACTIVATE) { *result = MA_NOACTIVATE; return true; }
        if (event->message == WM_NCHITTEST) { *result = HTTRANSPARENT; return true; }
        return false;
    }

private:
    static bool rectangle(const QJsonObject &r) {
        return integer(r.value("x"), -2000000, 2000000) && integer(r.value("y"), -2000000, 2000000)
            && integer(r.value("width"), 1, 32768) && integer(r.value("height"), 1, 32768);
    }
    static bool primaryBounds(RECT *bounds) {
        const HMONITOR monitor = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
        MONITORINFO info{}; info.cbSize = sizeof(info);
        if (!monitor || !GetMonitorInfoW(monitor, &info) || !(info.dwFlags & MONITORINFOF_PRIMARY)) return false;
        *bounds = info.rcMonitor; return true;
    }
    bool sameSource() const {
        if (display) { RECT bounds{}; return primaryBounds(&bounds) && EqualRect(&visibleSource, &bounds); }
        DWORD currentPid = 0; RECT current{}; RECT visible{};
        return source && IsWindow(source) && !IsIconic(source) && GetWindowThreadProcessId(source, &currentPid)
            && currentPid == pid && reinterpret_cast<quintptr>(GetPropW(source, key.c_str())) == markerValue
            && GetWindowRect(source, &current) && EqualRect(&original, &current)
            && SUCCEEDED(DwmGetWindowAttribute(source, DWMWA_EXTENDED_FRAME_BOUNDS, &visible, sizeof(visible)))
            && EqualRect(&visibleSource, &visible);
    }
    HWND handle{}; HWND source{}; DWORD pid{}; quintptr markerValue{};
    std::wstring key; RECT original{}; RECT visibleSource{}; qint64 generation{};
    bool excluded = false; bool display = false; bool hasPoint = false;
    QRect physical; QRect drawing; QSize canvas; QPoint point; QString style;
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
        {"overlay_hwnd", double(frame.windowId())}, {"qt_version", QT_VERSION_STR}, {"protocol_version", 2}, {"capture_affinity", double(captureExcluded)}});
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
