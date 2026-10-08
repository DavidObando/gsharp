using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.VisualStudio.TestPlatform.ObjectModel;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Client;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Logging;
using Microsoft.Win32.SafeHandles;

namespace Adr0198;

[FriendlyName("ADR0198")]
[ExtensionUri("logger://gsharp/adr0198/supervisor/v1")]
public sealed class TestSupervisorLogger : ITestLogger
{
    private StreamWriter? writer;

    public void Initialize(TestLoggerEvents events, string testRunDirectory)
    {
        string value = Environment.GetEnvironmentVariable("ADR0198_TEST_EVENT_FD")
            ?? throw new InvalidOperationException("ADR0198_TEST_EVENT_FD is missing");
        int descriptor = int.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
        if (fcntl(descriptor, 2, 1) != 0)
        {
            throw new InvalidOperationException("cannot protect the supervisor event channel");
        }

        writer = new StreamWriter(
            new FileStream(new SafeFileHandle((IntPtr)descriptor, ownsHandle: true), FileAccess.Write),
            new System.Text.UTF8Encoding(false))
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
        writer?.WriteLine(JsonSerializer.Serialize(value));
    }

    [DllImport("libc", SetLastError = true)]
    private static extern int fcntl(int descriptor, int command, int argument);
}
