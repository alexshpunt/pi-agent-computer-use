import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { displayModes as nativeDisplayModes, type DisplayModes } from "./display-mode.ts";
import { WINDOWS_POWERSHELL, type CommandRunner } from "./runner.ts";

/** One app process as Windows reports it; `responding` is false when its UI thread stopped handling messages. */
export interface ProcessHealth { pid: number; name: string; responding: boolean; memory_mb: number; cpu_seconds: number }
/** A recognised line of text with its box in the pixels of the image that was read. */
export interface TextLine { text: string; x: number; y: number; width: number; height: number; words: { text: string; x: number; y: number; width: number; height: number }[] }

/**
 * Work on the controlled machine that is neither capture nor input: display modes, an owned folder for files,
 * process health and Windows' built-in OCR. Commands run through the machine's runner, locally or over SSH.
 */
export class MachineHost {
  private folder?: Promise<{ windows: string; wsl: string }>;
  private readonly folderId = randomUUID();

  constructor(private readonly runner: CommandRunner, readonly displayModes: DisplayModes = nativeDisplayModes(runner)) {}

  private powershell(script: string, input?: string | Buffer, timeoutMs = 60_000): Promise<string> {
    return this.runner.run(WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
      Buffer.from(`$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'\ntry {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`, "utf16le").toString("base64")],
    { ...(input !== undefined ? { input } : {}), timeoutMs }).then(output => output.replace(/\r/g, "").trim());
  }

  /** This session's folder in the machine's Windows temp directory, created on first use. */
  files(): Promise<{ windows: string; wsl: string }> {
    this.folder ??= (async () => {
      const windows = await this.powershell(`$d = Join-Path ([IO.Path]::GetTempPath()) 'pi-computer-use\\${this.folderId}'; New-Item -ItemType Directory -Force -Path $d | Out-Null; $d`);
      const wsl = (await this.runner.run("wslpath", ["-u", windows])).trim();
      return { windows, wsl };
    })();
    this.folder.catch(() => { this.folder = undefined; });
    return this.folder;
  }

  /** Write bytes as a file in the owned folder and return its Windows path. */
  async put(name: string, bytes: Buffer): Promise<string> {
    const folder = await this.files();
    await this.runner.run("dd", ["status=none", `of=${folder.wsl}/${checkedName(name)}`], { input: bytes });
    return `${folder.windows}\\${name}`;
  }

  /** Read a file from the owned folder. */
  async get(name: string): Promise<Buffer> {
    const folder = await this.files();
    return Buffer.from((await this.runner.run("base64", ["-w0", `${folder.wsl}/${checkedName(name)}`], { timeoutMs: 120_000 })).trim(), "base64");
  }

  /** Rename a file inside the owned folder. */
  async rename(from: string, to: string): Promise<void> {
    const folder = await this.files();
    await this.runner.run("mv", ["-f", "--", `${folder.wsl}/${checkedName(from)}`, `${folder.wsl}/${checkedName(to)}`]);
  }

  /** Files in the owned folder with their sizes. */
  async list(): Promise<{ name: string; bytes: number }[]> {
    const folder = await this.files();
    const out = await this.runner.run("find", [folder.wsl, "-maxdepth", "1", "-type", "f", "-printf", "%f\\t%s\\n"]);
    return out.split("\n").filter(Boolean).map(line => { const [name, bytes] = line.split("\t"); return { name, bytes: Number(bytes) }; });
  }

  /** Remove the owned folder; called when the computer session closes. */
  async removeFiles(): Promise<void> {
    if (!this.folder) return;
    const folder = await this.folder.catch(() => undefined);
    this.folder = undefined;
    if (folder) await this.runner.run("rm", ["-rf", "--", folder.wsl]);
  }

  /**
   * Whether a window's process still handles messages, and how much memory and CPU it has used.
   * With a window handle, Windows' own hung-window test decides; the process's main window may be another one.
   */
  async processHealth(pid: number, window?: number): Promise<ProcessHealth | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || (window !== undefined && (!Number.isSafeInteger(window) || window <= 0))) return undefined;
    const responding = window === undefined ? "$p.Responding"
      : `-not (Add-Type -PassThru -Name Hung -Namespace PiComputerUse -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr window);')::IsHungAppWindow([IntPtr]${window})`;
    const out = await this.powershell(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { @{ pid = $p.Id; name = $p.ProcessName; responding = [bool](${responding}); memory_mb = [math]::Round($p.WorkingSet64 / 1MB); cpu_seconds = [math]::Round($p.CPU, 1) } | ConvertTo-Json -Compress }`, undefined, 20_000);
    return out ? JSON.parse(out) as ProcessHealth : undefined;
  }

  /** The clipboard's image as PNG bytes, or undefined when it holds no image. */
  async clipboardImage(): Promise<Buffer | undefined> {
    const folder = await this.files();
    const name = `clipboard-${Date.now()}.png`;
    const saved = await this.powershell(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${folder.windows.replace(/'/g, "''")}\\${name}', [Drawing.Imaging.ImageFormat]::Png); 'saved' }`, undefined, 20_000);
    if (saved !== "saved") return undefined;
    try { return await this.get(name); }
    finally { await this.runner.run("rm", ["-f", "--", `${folder.wsl}/${name}`]).catch(() => undefined); }
  }

  /**
   * Recognise text with Windows.Media.Ocr in the user's languages. Boxes are in the given image's pixels;
   * a region is cut from it, enlarged up to 2x for small glyphs, and its boxes are mapped back.
   */
  async ocr(image: Buffer, region?: { x: number; y: number; width: number; height: number }): Promise<TextLine[]> {
    let png = image, box = (value: Omit<TextLine, "words">) => value;
    if (region) {
      const meta = await sharp(image).metadata();
      const left = Math.max(0, Math.floor(region.x)), top = Math.max(0, Math.floor(region.y));
      const width = Math.min(meta.width! - left, Math.ceil(region.x + region.width) - left), height = Math.min(meta.height! - top, Math.ceil(region.y + region.height) - top);
      if (width <= 0 || height <= 0) throw new Error("The region is outside this observation's image.");
      const scale = Math.max(1, Math.min(2, Math.floor(2600 / Math.max(width, height))));
      png = await sharp(image).extract({ left, top, width, height }).resize(width * scale, height * scale, { kernel: "lanczos3" }).png().toBuffer();
      box = value => ({ ...value, x: Math.round(left + value.x / scale), y: Math.round(top + value.y / scale), width: Math.round(value.width / scale), height: Math.round(value.height / scale) });
    }
    const name = `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const path = await this.put(name, png);
    try {
      const out = await this.powershell(OCR_SCRIPT.replace("__PATH__", path.replace(/'/g, "''")), undefined, 60_000);
      const lines = out ? JSON.parse(out) as TextLine[] : [];
      return lines.map(line => ({ ...box(line), words: line.words.map(word => box(word) as TextLine["words"][number]) }));
    } finally {
      const folder = await this.files();
      await this.runner.run("rm", ["-f", "--", `${folder.wsl}/${name}`]).catch(() => undefined);
    }
  }
}

/** Accept plain file names only, so a name never leaves the owned folder. */
export function checkedName(name: string): string {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}$/.test(name) || name.includes("..")) throw new Error("Use a plain file name: letters, digits, space, dot, dash, underscore or brackets.");
  return name;
}

const OCR_SCRIPT = String.raw`
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + String.raw`1' })[0]
function Await($operation, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation)); $task.Wait(-1) | Out-Null; $task.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('__PATH__')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { throw 'Windows OCR has no installed recognition language.' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
$lines = @(foreach ($line in $result.Lines) {
  $words = @(foreach ($w in $line.Words) { $r = $w.BoundingRect; [pscustomobject]@{ text = $w.Text; x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height } })
  $x = ($words | Measure-Object -Property x -Minimum).Minimum; $y = ($words | Measure-Object -Property y -Minimum).Minimum
  $right = ($words | ForEach-Object { $_.x + $_.width } | Measure-Object -Maximum).Maximum; $bottom = ($words | ForEach-Object { $_.y + $_.height } | Measure-Object -Maximum).Maximum
  [pscustomobject]@{ text = $line.Text; x = [int]$x; y = [int]$y; width = [int]($right - $x); height = [int]($bottom - $y); words = $words }
})
ConvertTo-Json -InputObject $lines -Depth 5 -Compress
`;
