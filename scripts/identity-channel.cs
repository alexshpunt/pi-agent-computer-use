using System.IO;
using System.Threading.Tasks;

public static class PiIdentityPipe {
    // Process stdin is buffered. Flush each request chunk rather than waiting for its pipe buffer to fill.
    public static async Task CopyAndFlushAsync(Stream source, Stream destination) {
        byte[] buffer = new byte[4096];
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0) {
            await destination.WriteAsync(buffer, 0, count).ConfigureAwait(false);
            await destination.FlushAsync().ConfigureAwait(false);
        }
    }
}
