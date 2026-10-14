package Adr0198

import Microsoft.VisualStudio.TestPlatform.ObjectModel
import Microsoft.VisualStudio.TestPlatform.ObjectModel.Client
import Microsoft.VisualStudio.TestPlatform.ObjectModel.Logging
import Microsoft.Win32.SafeHandles
import System
import System.Globalization
import System.IO
import System.Net.Sockets
import System.Runtime.InteropServices
import System.Text
import System.Text.Json

@FriendlyName("ADR0198")
@ExtensionUri("logger://gsharp/adr0198/supervisor/v1")
class TestSupervisorLogger : ITestLogger {
    private var writer StreamWriter?

    func Initialize(events TestLoggerEvents, testRunDirectory string) {
        let value = Environment.GetEnvironmentVariable("ADR0198_TEST_EVENT_FD") ??
            throw InvalidOperationException("ADR0198_TEST_EVENT_FD is missing")
        let challenge = Environment.GetEnvironmentVariable("ADR0198_TEST_EVENT_CHALLENGE") ??
            throw InvalidOperationException("ADR0198_TEST_EVENT_CHALLENGE is missing")
        let descriptor = int32.Parse(value, CultureInfo.InvariantCulture)
        Environment.SetEnvironmentVariable("ADR0198_TEST_EVENT_FD", nil)
        Environment.SetEnvironmentVariable("ADR0198_TEST_EVENT_CHALLENGE", nil)
        if fcntl(descriptor, 2, 1) != 0 {
            throw InvalidOperationException("cannot protect the supervisor event channel")
        }
        let socket = Socket(SafeSocketHandle(nint(descriptor), ownsHandle: true))
        writer = StreamWriter(NetworkStream(socket, ownsSocket: true), UTF8Encoding(false)){AutoFlush = true}
        Write(AnonymousType3_804F97A1F4E80235("ready", challenge, Environment.ProcessId))
        events.TestRunStart += (_ object?, _ TestRunStartEventArgs) -> Write(AnonymousType1_712031FD07530BFD("started"))
        events.TestResult += (_ object?, args TestResultEventArgs) -> Write(
            AnonymousType4_F214DB27053C2E29(
                "result",
                args.Result.TestCase.FullyQualifiedName,
                args.Result.TestCase.Source,
                args.Result.Outcome.ToString()
            )
        )
        events.TestRunComplete += (_ object?, args TestRunCompleteEventArgs) -> {
            let total = args.TestRunStatistics?.ExecutedTests ?? int64(0)
            let passed = Count(args, TestOutcome.Passed)
            let failed = Count(args, TestOutcome.Failed)
            let skipped = Count(args, TestOutcome.Skipped)
            Write(
                AnonymousType7_C17DA181BCCDE520(
                    "completed",
                    total,
                    passed,
                    failed,
                    skipped,
                    args.IsCanceled,
                    args.IsAborted
                )
            )
            writer?.Dispose()
            writer = nil
        }
    }

    private func Write(value object) {
        if writer == nil {
            throw InvalidOperationException("test supervisor is not initialized")
        }
        writer!!.WriteLine(JsonSerializer.Serialize(value))
    }

    shared {
        private func Count(args TestRunCompleteEventArgs, outcome TestOutcome) int64 {
            if args.TestRunStatistics?.Stats == nil {
                return 0
            }
            return if args.TestRunStatistics!!.Stats!!.TryGetValue(outcome, out var count) {
                count
            } else {
                int64(0)
            }
        }

        @DllImport("libc", SetLastError = true)
        private func fcntl(descriptor int32, command int32, argument int32) int32;
    }
}

internal data class AnonymousType3_804F97A1F4E80235(type string, challenge string, pid int32) { }

internal data class AnonymousType1_712031FD07530BFD(type string) { }

internal data class AnonymousType4_F214DB27053C2E29(type string, name string, source string, outcome string) { }

internal data class AnonymousType7_C17DA181BCCDE520(
    type string,
    total int64,
    passed int64,
    failed int64,
    skipped int64,
    canceled bool,
    aborted bool
) { }
