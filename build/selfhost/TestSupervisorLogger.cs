using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.VisualStudio.TestPlatform.ObjectModel;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Client;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Logging;

namespace Adr0198;

[FriendlyName("ADR0198")]
[ExtensionUri("logger://gsharp/adr0198/supervisor/v1")]
public sealed class TestSupervisorLogger : ITestLogger
{
    private StreamWriter? writer;

    public void Initialize(TestLoggerEvents events, string testRunDirectory)
    {
        string path = Environment.GetEnvironmentVariable("ADR0198_TEST_EVENT_SOCKET")
            ?? throw new InvalidOperationException("ADR0198_TEST_EVENT_SOCKET is missing");
        Environment.SetEnvironmentVariable("ADR0198_TEST_EVENT_SOCKET", null);
        Socket socket = new(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        socket.Connect(new UnixDomainSocketEndPoint(path));
        writer = new StreamWriter(new NetworkStream(socket, ownsSocket: true), new UTF8Encoding(false))
        {
            AutoFlush = true,
        };
        events.TestRunStart += (_, _) => Write(new { type = "started" });
        events.TestResult += (_, args) => Write(new
        {
            type = "result",
            name = args.Result.TestCase.FullyQualifiedName,
            source = args.Result.TestCase.Source,
            outcome = args.Result.Outcome.ToString(),
        });
        events.TestRunComplete += (_, args) =>
        {
            long total = args.TestRunStatistics?.ExecutedTests ?? 0;
            long passed = Count(args, TestOutcome.Passed);
            long failed = Count(args, TestOutcome.Failed);
            long skipped = Count(args, TestOutcome.Skipped);
            Write(new { type = "completed", total, passed, failed, skipped, canceled = args.IsCanceled, aborted = args.IsAborted });
            writer?.Dispose();
            writer = null;
        };
    }

    private static long Count(TestRunCompleteEventArgs args, TestOutcome outcome)
    {
        if (args.TestRunStatistics?.Stats is null)
        {
            return 0;
        }

        return args.TestRunStatistics.Stats.TryGetValue(outcome, out long count) ? count : 0;
    }

    private void Write(object value)
    {
        if (writer is null)
        {
            throw new InvalidOperationException("test supervisor is not initialized");
        }

        writer.WriteLine(JsonSerializer.Serialize(value));
    }
}
