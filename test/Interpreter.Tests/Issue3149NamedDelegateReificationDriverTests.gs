// <copyright file="Issue3149NamedDelegateReificationDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Repl
import System
import System.Collections.Generic
import System.IO
import System.Reflection
import System.Runtime.Loader
import System.Text.RegularExpressions
import System.Threading
import System.Threading.Tasks
import Xunit

/// Non-generic named-delegate fixture imported by the G# consumer.
delegate Issue3149Greeter(value string) int32;

/// Generic named-delegate fixture imported by the G# consumer.
/// @typeparam T Delegate argument type.
delegate Issue3149Mapper[T](value T) int32;

/// Mixed overloads whose second parameter selects open or closed candidate.
shared class Issue3149MixedDelegateOverloads {
    /// Returns the closed named delegate.
    func Choose(callback Issue3149Greeter, marker string) Issue3149Greeter -> callback

    /// Returns the inferred open-generic delegate.
    func Choose[T](callback(T) -> int32, marker int32)(T) -> int32 -> callback
}

/// Imported type argument for (cref:Issue3149Mapper{T}).
class Issue3149Item {
    /// Initializes a new instance of the (cref:Issue3149Item) class.
    /// @param value Stored value.
    init(value int32) {
        Value = value
    }

    /// Gets the stored value.
    prop Value int32 {
        get;
    }
}

/// Issue #3149: lambdas flowing through imported erased generic slots retain
/// their declared named-delegate type.
@Collection("ConsoleIo")
class Issue3149NamedDelegateReificationDriverTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    async func MixedOpenAndClosedCandidates_ReifySelectedDelegateAcrossDrivers(selectOpen bool) {
        let suffix = if selectOpen {
            "Open"
        } else {
            "Closed"
        }
        let consumerPackage = "Issue3149Mixed" + suffix
        let directory = CreateEmptyTestDirectory("Mixed" + suffix)
        try {
            let referencePath = typeof(Issue3149Greeter).Assembly.Location
            File.Copy(referencePath, Path.Combine(directory, Path.GetFileName(referencePath)))
            let statements = if selectOpen {
                `let callback = Issue3149MixedDelegateOverloads.Choose((value string) -> value.Length + 50, 1)
Console.WriteLine(callback.GetType().FullName)
Console.WriteLine(callback!!("abc"))`
            } else {
                `let callbacks = List[Issue3149Greeter]()
callbacks.Add((value string) -> value.Length + 40)
let callback = callbacks[0]
Console.WriteLine(callback.GetType().FullName)
Console.WriteLine(callback("abc"))`
            }
            let sourcePath = WriteSource(directory, "consumer.gs", (`package ` + "$consumerPackage" + `
import System
import System.Collections.Generic
import GSharp.Interpreter.Tests
import GSharp.Interpreter.Tests.Issue3149Mixed

public class Probe {
    shared {
        public func Run() {
            ` + "$statements" + `
        }
    }
}

Probe.Run()`))
            let expectedOutput = if selectOpen {
                "${typeof((string) -> int32).FullName}${Environment.NewLine}53${Environment.NewLine}"
            } else {
                "${typeof(Issue3149Greeter).FullName}${Environment.NewLine}43${Environment.NewLine}"
            }
            let bare = RunCompiler("/nowarn:GS9100", "/r:" + referencePath, sourcePath)
            let assemblyPath = Path.Combine(directory, consumerPackage + ".dll")
            let emitCompile = RunCompiler(
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + assemblyPath,
                "/r:" + referencePath,
                sourcePath
            )
            let emitted = if emitCompile.ExitCode == 0 {
                await RunAssemblyAsync(directory, assemblyPath)
            } else {
                emitCompile
            }
            let script = RunScriptDriver(sourcePath)
            let failures = List[string]()
            CheckBareDriver(bare, expectedOutput, failures)
            CheckDriver("gsc /out:", emitted, expectedOutput, failures)
            CheckDriver("gsi", script, expectedOutput, failures)
            Assert.True(failures.Count == 0, string.Join(`

`, failures))
        } finally {
            DeleteDirectory(directory)
        }
    }

    /// Issue #4130 regression: a driver that exits 0 with the right program
    /// output must still pass even when it also prints a legitimate
    /// WARNING-severity diagnostic. This is deliberately independent of the
    /// self-hosting nondeterminism that originally surfaced the bug —
    /// GS0536 ("Redundant '!!'", reported by ExpressionBinder's
    /// `ReportNullAssertionIfRedundant`) fires unconditionally whenever
    /// `!!` is applied to a statically non-nullable value, so a plain
    /// `int` reproduces the same "warning alongside a successful run"
    /// shape deterministically under the *native* compiler, with no need to
    /// reproduce the self-hosted build that #4130 actually hit. Before
    /// #4130's fix to (cref:CheckDriver), this test fails because the
    /// warning's text pollutes the bare driver's stdout / breaks the
    /// exact-output-equality check.
    @Fact
    func BareDriverWarning_RedundantNullAssertion_DoesNotFailDriverCheck() {
        let directory = CreateEmptyTestDirectory("RedundantBangBang")
        try {
            let sourcePath = WriteSource(directory, "warn.gs", `import System
let value = 41
Console.WriteLine(value!! + 1)`)
            let bare = RunCompiler(sourcePath)
            // The warning must actually have fired — otherwise this test
            // would pass whether or not #4130's CheckDriver fix is present,
            // and would not be discriminating between the two.
            Assert.Contains("GS0536", bare.StandardOutput, StringComparison.Ordinal)
            let failures = List[string]()
            CheckBareDriver(bare, "42" + Environment.NewLine, failures)
            Assert.True(failures.Count == 0, string.Join(`

`, failures))
        } finally {
            DeleteDirectory(directory)
        }
    }

    /// Review finding on #4178: the sibling test above exercises only bare
    /// `gsc`'s STDOUT diagnostic path. `gsi` ((cref:GSharp.Repl.Program))
    /// renders every diagnostic to STANDARD ERROR regardless of severity — a
    /// different stream than bare `gsc` uses — so a `StripDiagnosticNoise`
    /// regression specific to stderr, or to `gsi`'s own diagnostic
    /// rendering, would not be caught by the stdout-only test above. This is
    /// the same deterministic GS0536 shape, routed through
    /// (cref:RunScriptDriver) and checked with the same
    /// (cref:CheckDriver) the real `Issue3149` test uses for its own
    /// `gsi` leg, so this test and that one can never disagree about what
    /// `CheckDriver` accepts on the `gsi` path.
    @Fact
    func ScriptDriverWarning_RedundantNullAssertion_DoesNotFailDriverCheck() {
        let directory = CreateEmptyTestDirectory("RedundantBangBangScript")
        try {
            let sourcePath = WriteSource(directory, "warn.gs", `import System
let value = 41
Console.WriteLine(value!! + 1)`)
            let script = RunScriptDriver(sourcePath)
            // The warning must actually have fired, and on STDERR specifically
            // -- otherwise this test would pass whether or not the gsi leg of
            // #4130's fix is present, and would not be discriminating.
            Assert.Contains("GS0536", script.StandardError, StringComparison.Ordinal)
            let failures = List[string]()
            CheckDriver("gsi", script, "42" + Environment.NewLine, failures)
            Assert.True(failures.Count == 0, string.Join(`

`, failures))
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    async func SingleCandidateNamedDelegateThroughErasedListSlot_AllDriversReifyAndInvoke(generic bool) {
        let suffix = if generic {
            "Generic"
        } else {
            "NonGeneric"
        }
        let consumerPackage = "Issue3149Consumer" + suffix
        let directory = CreateEmptyTestDirectory(suffix)
        try {
            let referencePath = typeof(Issue3149Greeter).Assembly.Location
            let copiedReferencePath = Path.Combine(directory, Path.GetFileName(referencePath))
            File.Copy(referencePath, copiedReferencePath)
            let consumerSource = CreateConsumerSource(consumerPackage, generic)
            Assert.DoesNotContain(
                "import GSharp.Interpreter.Tests.Issue3149Mixed",
                consumerSource,
                StringComparison.Ordinal
            )
            let sourcePath = WriteSource(directory, "consumer.gs", consumerSource)
            let expectedOutput = if generic {
                "${typeof(Issue3149Mapper[_]).FullName}${Environment.NewLine}${typeof(Issue3149Item).FullName}${Environment.NewLine}24${Environment.NewLine}"
            } else {
                "${typeof(Issue3149Greeter).FullName}${Environment.NewLine}13${Environment.NewLine}"
            }
            let bare = RunCompiler("/nowarn:GS9100", "/r:" + referencePath, sourcePath)
            let assemblyPath = Path.Combine(directory, consumerPackage + ".dll")
            let emitCompile = RunCompiler(
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + assemblyPath,
                "/r:" + referencePath,
                sourcePath
            )
            let emitted = if emitCompile.ExitCode == 0 {
                await RunAssemblyAsync(directory, assemblyPath)
            } else {
                emitCompile
            }
            let script = RunScriptDriver(sourcePath)
            let inspection = if emitCompile.ExitCode == 0 {
                InspectProducedDelegate(copiedReferencePath, assemblyPath, consumerPackage, generic)
            } else {
                InspectionResult.Failed("emit compilation failed")
            }
            AssertAllResults(bare, emitted, script, inspection, expectedOutput, generic)
        } finally {
            DeleteDirectory(directory)
        }
    }

    /// Review finding on #4178: confirms the boundary the fix deliberately
    /// keeps -- (cref:CompilerDiagnosticsBlock) strips WARNING/INFO
    /// text so a legitimate non-fatal diagnostic cannot fail
    /// (cref:CheckDriver), but must never strip an ERROR. A driver
    /// that (hypothetically, via its own bug) reports a real error yet still
    /// exits 0 must still be caught here through the exact-output-equality
    /// check, not silently waved through because #4130's fix trusted
    /// `ExitCode` alone. Constructs the hazard directly (a synthetic
    /// (cref:DriverResult) with an error diagnostic AND exit code 0)
    /// rather than trying to make a real driver misbehave.
    @Fact
    func ErrorDiagnosticAlongsideFakeSuccessExitCode_StillFailsCheckDriver() {
        let fakeResult = Issue3149NamedDelegateReificationDriverTests.DriverResult(0, `
fake.gs(1,1,1,2): error GS9999: something is actually broken
let x = 1

` + "42" + Environment.NewLine, string.Empty)
        let failures = List[string]()
        CheckDriver("probe", fakeResult, "42" + Environment.NewLine, failures)
        Assert.True(
            failures.Count > 0,
            "CheckDriver must still fail when an error diagnostic is present, even though " +
                "warnings/info are excluded from the stdout-equality strip -- if this assertion " +
                "fails, the strip regex is (again) silently eating errors too."
        )
    }

    private data class DriverResult(ExitCode int32, StandardOutput string, StandardError string) : IEquatable[
        Issue3149NamedDelegateReificationDriverTests.DriverResult
    ] { }

    private data class InspectionResult(
        ActualDefinition string?,
        ActualArgument string?,
        InvocationResult object?,
        Error string?
    ) : IEquatable[InspectionResult] {
        shared {
            func Failed(error string) InspectionResult -> InspectionResult(nil, nil, nil, error)
        }
    }

    shared {
        private func CreateConsumerSource(consumerPackage string, generic bool) string -> if generic {
            (`package ` + "$consumerPackage" + `
import System
import System.Collections.Generic
import GSharp.Interpreter.Tests

public class Probe {
    shared {
        public func Create() Issue3149Mapper[Issue3149Item] {
            let callbacks = List[Issue3149Mapper[Issue3149Item]]()
            callbacks.Add((value Issue3149Item) -> value.Value + 20)
            return callbacks[0]
        }

        public func Run() {
            let callback = Create()
            let callbackType = callback.GetType()
            Console.WriteLine(callbackType.GetGenericTypeDefinition().FullName)
            Console.WriteLine(callbackType.GetGenericArguments()[0].FullName)
            Console.WriteLine(callback(Issue3149Item(4)))
        }
    }
}

Probe.Run()`)
        } else {
            (`package ` + "$consumerPackage" + `
import System
import System.Collections.Generic
import GSharp.Interpreter.Tests

public class Probe {
    shared {
        public func Create() Issue3149Greeter {
            let callbacks = List[Issue3149Greeter]()
            callbacks.Add((value string) -> value.Length + 10)
            return callbacks[0]
        }

        public func Run() {
            let callback = Create()
            Console.WriteLine(callback.GetType().FullName)
            Console.WriteLine(callback("abc"))
        }
    }
}

Probe.Run()`)
        }

        private func InspectProducedDelegate(
            referencePath string,
            assemblyPath string,
            consumerPackage string,
            generic bool
        ) InspectionResult {
            try {
                Assert.NotEmpty(typeof(Issue3149Greeter).Assembly.GetTypes())
                let loadContext = AssemblyLoadContext("Issue3149_" + Guid.NewGuid().ToString("N"), isCollectible: true)
                try {
                    let library = loadContext.LoadFromAssemblyPath(referencePath)
                    loadContext.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> {
                        if name.Name == library.GetName().Name {
                            return library
                        }
                        let dependencyPath = Path.Combine(AppContext.BaseDirectory, name.Name + ".dll")
                        return if File.Exists(dependencyPath) {
                            loadContext.LoadFromAssemblyPath(dependencyPath)
                        } else {
                            default(Assembly?)
                        }
                    }
                    let consumer = loadContext.LoadFromAssemblyPath(assemblyPath)
                    Assert.NotEmpty(consumer.GetTypes())
                    let probe = consumer.GetType(consumerPackage + ".Probe") ??
                        throw InvalidOperationException("Emitted Probe type was not found.")
                    let create = probe.GetMethod("Create", BindingFlags.Public | BindingFlags.Static) ??
                        throw InvalidOperationException("Emitted Probe.Create method was not found.")
                    let value = create.Invoke(nil, nil) as Delegate ??
                        throw InvalidOperationException("Probe.Create did not return a delegate.")
                    let actualType = value.GetType()
                    let actualDefinition string? = if actualType.IsGenericType {
                        actualType.GetGenericTypeDefinition().FullName
                    } else {
                        actualType.FullName
                    }
                    let actualArgument string? = if generic {
                        actualType.GetGenericArguments()[0].FullName
                    } else {
                        default(string?)
                    }
                    let invocationArgument object? = if generic {
                        Activator.CreateInstance(
                            library.GetType(typeof(Issue3149Item).FullName!!) ??
                                throw InvalidOperationException("Imported Item type was not found."),
                            4
                        )
                    } else {
                        cast[object]("abc")
                    }
                    let invocationResult object? = value.DynamicInvoke(invocationArgument)
                    return InspectionResult(actualDefinition, actualArgument, invocationResult, nil)
                } finally {
                    loadContext.Unload()
                }
            } catch (ex Exception) {
                return InspectionResult.Failed(ex.ToString())
            }
        }

        private func AssertAllResults(
            bare Issue3149NamedDelegateReificationDriverTests.DriverResult,
            emitted Issue3149NamedDelegateReificationDriverTests.DriverResult,
            script Issue3149NamedDelegateReificationDriverTests.DriverResult,
            inspection InspectionResult,
            expectedOutput string,
            generic bool
        ) {
            let failures = List[string]()
            CheckBareDriver(bare, expectedOutput, failures)
            CheckDriver("gsc /out:", emitted, expectedOutput, failures)
            CheckDriver("gsi", script, expectedOutput, failures)
            let expectedDefinition string? = if generic {
                typeof(Issue3149Mapper[_]).FullName
            } else {
                typeof(Issue3149Greeter).FullName
            }
            let expectedArgument string? = if generic {
                typeof(Issue3149Item).FullName
            } else {
                default(string?)
            }
            if !string.Equals(inspection.ActualDefinition, expectedDefinition, StringComparison.Ordinal) ||
                !string.Equals(inspection.ActualArgument, expectedArgument, StringComparison.Ordinal) || !object.Equals(
                inspection.InvocationResult,
                if generic {
                    24
                } else {
                    13
                }
            ) ||
                inspection.Error != nil {
                failures.Add("delegate inspection failed:" + (`
  expected type: ` + "$expectedDefinition") + (`
  actual type: ` + "${inspection.ActualDefinition ?? "<none>"}") + (`
  expected argument: ` + "${expectedArgument ?? "<none>"}") + (`
  actual argument: ` + "${inspection.ActualArgument ?? "<none>"}") + (`
  invocation: ` + "${inspection.InvocationResult ?? "<none>"}") + (`
  error: ` + "${inspection.Error ?? "<none>"}"))
            }
            Assert.True(failures.Count == 0, string.Join(`

`, failures))
        }

        private func CheckBareDriver(
            result Issue3149NamedDelegateReificationDriverTests.DriverResult,
            expectedOutput string,
            failures List[string]
        ) -> CheckDriver("gsc", result, expectedOutput + "Success.\n", failures)

        // Issue #4130: bare `gsc` and `gsi` both document that a *successful*
        // run may still print diagnostics — bare `gsc`'s ExecuteInMemory
        // (src/Compiler/Program.cs) prints warnings to stdout ahead of its
        // "Success." trailer, and gsi's RunScript (src/Repl/Program.cs) always
        // "renders [diagnostics] to standard error, the program's output
        // streams straight through" regardless of severity. Neither driver's
        // success contract is "diagnostic-free" — it is "exit code 0", which
        // both already gate on the absence of an ERROR-severity diagnostic
        // (ExecuteInMemory returns non-zero when `effective.Any(d => d.IsError)`;
        // RunScript returns 1 when `!result.Success`). Requiring the raw
        // stdout/stderr text to be byte-for-byte diagnostic-free — as this check
        // did before #4130 — turns a legitimate warning into a false "driver
        // failed", which is exactly what happened here: the reified open-generic
        // delegate case (`selectOpen: true`) triggers GS0536 ("Redundant '!!':
        // the value is already non-null here") on `callback!!("abc")` under a
        // self-hosted gsc whose nullability inference for the mixed open/closed
        // overload is tighter than the native compiler's, even though the actual
        // program output — the whole point of this test — is unaffected. Strip
        // the compiler's own diagnostic blocks (recognisable by
        // TextWriterExtensions.WriteDiagnostics's fixed shape) before comparing,
        // so a driver that exits 0 with the right program output only fails here
        // when its OWN output is actually wrong.
        private func CheckDriver(
            name string,
            result Issue3149NamedDelegateReificationDriverTests.DriverResult,
            expectedOutput string,
            failures List[string]
        ) {
            let actualOutput = StripDiagnosticNoise(result.StandardOutput)
            let actualError = StripDiagnosticNoise(result.StandardError)
            if result.ExitCode != 0 || !string.Equals(
                Normalize(actualOutput),
                expectedOutput,
                StringComparison.Ordinal
            ) ||
                actualError.Length != 0 {
                failures.Add("$name failed:" + (`
  exit: ` + "${result.ExitCode}") + (`
  stdout:
` + "${Normalize(result.StandardOutput)}") + (`
  stderr:
` + "${result.StandardError}"))
            }
        }

        // Matches one full TextWriterExtensions.WriteDiagnostics dump: one or
        // more diagnostic entries, each a blank separator line followed by
        // either a located header ("<file>(sl,sc,el,ec): <severity> <id>:
        // <message>") plus its one-line source snippet, or a location-less
        // header ("<severity> <id>: <message>") alone — then the single extra
        // blank line WriteDiagnostics always appends after the last entry.
        // Matching (and removing) the run as one unit, rather than per-line,
        // keeps that shared trailing blank line from being left behind as
        // stray whitespace once the diagnostics themselves are stripped.
        //
        // Review finding on #4178: deliberately WARNING/INFO only, never
        // `error`. #4130's fix is meant to tolerate a driver that succeeds
        // despite printing a non-fatal diagnostic -- it is not meant to make
        // this check blind to a driver that emits an actual error and still
        // (incorrectly) exits 0. Stripping `error` text here would leave
        // CheckDriver trusting ExitCode alone for that case, silently
        // re-opening the exact class of false-negative this fix exists to
        // close, just for a worse condition than the one it was written for.
        private let CompilerDiagnosticsBlock Regex = Regex(
            "(?:\\r?\\n(?:.*\\(\\d+,\\d+,\\d+,\\d+\\):\\ (?:warning|info)\\ [A-Za-z0-9]+:\\ .*\\r?\\n.*\\r?\\n" +
                "|(?:warning|info)\\ [A-Za-z0-9]+:\\ .*\\r?\\n))+\\r?\\n",
            RegexOptions.Compiled
        )

        private func StripDiagnosticNoise(text string) string -> if string.IsNullOrEmpty(text) {
            text
        } else {
            CompilerDiagnosticsBlock.Replace(text, string.Empty)
        }

        private func RunCompiler(
            arguments ...string
        ) Issue3149NamedDelegateReificationDriverTests.DriverResult -> Issue3149NamedDelegateReificationDriverTests.Capture(
            () -> GSharp.Compiler.Program.Main(arguments)
        )

        private func RunScriptDriver(
            sourcePath string
        ) Issue3149NamedDelegateReificationDriverTests.DriverResult -> Issue3149NamedDelegateReificationDriverTests.Capture(
            () -> GSharp.Repl.Program.Main([]string{sourcePath})
        )

        private func Capture(action() -> int32) Issue3149NamedDelegateReificationDriverTests.DriverResult {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                try {
                    return Issue3149NamedDelegateReificationDriverTests.DriverResult(
                        action(),
                        stdout.ToString(),
                        stderr.ToString()
                    )
                } catch (ex Exception) {
                    return Issue3149NamedDelegateReificationDriverTests.DriverResult(
                        -1,
                        stdout.ToString(),
                        stderr.ToString() + ex.ToString()
                    )
                }
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private async func RunAssemblyAsync(
            directory string,
            assemblyPath string
        ) Issue3149NamedDelegateReificationDriverTests
            .DriverResult {
            let runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json")
            File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            try {
                let result = await DotnetProcess.RunAsync(
                    directory,
                    []string{"exec", "--runtimeconfig", runtimeConfigPath, assemblyPath}
                )
                return Issue3149NamedDelegateReificationDriverTests.DriverResult(
                    result.ExitCode,
                    result.StandardOutput,
                    result.StandardError
                )
            } catch (ex Exception) {
                return Issue3149NamedDelegateReificationDriverTests.DriverResult(-1, string.Empty, ex.ToString())
            }
        }

        private func WriteSource(directory string, fileName string, source string) string {
            let path = Path.Combine(directory, fileName)
            File.WriteAllText(path, source)
            return path
        }

        private func CreateEmptyTestDirectory(suffix string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3149_" + suffix + "_" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            Assert.Empty(Directory.EnumerateFileSystemEntries(directory))
            return directory
        }

        private func DeleteDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }

        private func Normalize(value string) string -> value.ReplaceLineEndings(Environment.NewLine)
    }
}
