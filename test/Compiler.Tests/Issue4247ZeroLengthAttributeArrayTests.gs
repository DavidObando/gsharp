// <copyright file="Issue4247ZeroLengthAttributeArrayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #4247: `[N]T` written with NO initializer at all (not even
/// empty braces `{}`) parses as the runtime/zero-initialised allocation
/// form (issue #1272) — its length lives in
/// `ArrayCreationExpressionSyntax.LengthExpression`, and binding it
/// produces a `BoundArrayCreationExpression` with NO element list at
/// all (`ArrayCreationExpressionSyntax.Elements` stays
/// `null`). `DeclarationBinder.TryBindAttributeArrayArgument`
/// unconditionally required `syntax.Elements` to be present, so even
/// the constant, zero-length spelling `[0]Kind` was rejected with
/// `GS0202` — although Roslyn accepts the equivalent `new
/// Kind[0]`, and G#'s own explicit-empty-initializer spellings
/// (`[]Kind{}`, `[0]Kind{}`) already worked, since THOSE populate
/// `Elements` with zero items rather than leaving it null.
///
/// Fixed by accepting the no-initializer form once its length resolves to
/// the literal constant `0` (a zero-length SZARRAY is exactly as
/// constant and serialisable as an explicit empty initializer); any other
/// runtime length — a variable, or a nonzero constant with no initializer
/// to supply its elements — still has no constant element list to
/// serialize and correctly keeps reporting `GS0202`.
open class Issue4247ZeroLengthAttributeArrayTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func NoInitializerZeroLengthArray_CompilesAndReifiesAsEmptyArray(imported bool) {
        let elementType = if imported {
            "DayOfWeek"
        } else {
            "Kind"
        }
        let enumDeclaration = if imported {
            string.Empty
        } else {
            "enum Kind { First = 7 }\n"
        }
        let tempDir = Directory.CreateTempSubdirectory("gs_4247_zero_len_").FullName
        try {
            let source = (`package P
import System
` + "$enumDeclaration" + `class EAttribute(Values []` + "$elementType" + `) : Attribute {}
@E([0]` + "$elementType" + `)
class Target {}
Console.WriteLine("ok")`)
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            let ids = ErrorIds(log)
            Assert.True(
                ids.Length == 0,
                (
                    `a no-initializer zero-length attribute array argument must compile clean. Reported: [` +
                        "${string.Join(", ", ids)}" +
                        `]
Log:
` +
                        "$log"
                )
            )
            Assert.True(File.Exists(appPath), (`must produce an assembly. Log:
` + "$log"))
            IlVerifier.Verify(appPath)
            let (argumentType, values) = ReadArrayArgument(appPath, "Target")
            Assert.Equal(
                if imported {
                    "System.DayOfWeek[]"
                } else {
                    "P.Kind[]"
                },
                argumentType
            )
            Assert.Empty(values)
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the emitted program must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal("ok", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4247 follow-up (Copilot review): the issue's own repro is an
    /// `object`-VALUED attribute constructor parameter (Roslyn's
    /// `[Value(new Kind[0])]`), not a directly array-typed one — a
    /// different constructor-argument shape from
    /// (cref:NoInitializerZeroLengthArray_CompilesAndReifiesAsEmptyArray).
    /// Confirmed this is a genuinely separate gap: reverting the product fix
    /// reproduces the identical `GS0202` for this shape too, so this
    /// pins the exact scenario the issue named.
    @Fact
    func NoInitializerZeroLengthArray_AsObjectValuedConstructorArgument_CompilesAndReifiesAsEmptyArray() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4247_object_valued_").FullName
        try {
            const Source = `package P
import System
enum Kind { First = 7 }
class EAttribute(Values object) : Attribute {}
@E([0]Kind)
class Target {}
Console.WriteLine("ok")`
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.True(ErrorIds(log).Length == 0, log)
            Assert.True(File.Exists(appPath), log)
            IlVerifier.Verify(appPath)
            let (argumentType, values) = ReadArrayArgument(appPath, "Target")
            Assert.Equal("P.Kind[]", argumentType)
            Assert.Empty(values)
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the emitted program must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal("ok", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4247 follow-up (Copilot review): the fix's scope is the
    /// attribute-constant binder, but the SAME no-initializer zero-length
    /// syntax is ordinary, non-attribute array-creation syntax too. Boxing
    /// it to `object` and running the program exercises the actual
    /// runtime value (not just metadata read back through
    /// (cref:MetadataLoadContext)) — including that it keeps its
    /// real enum-array identity through the box/reverse-cast round trip
    /// (the reverse cast itself is #4246's separate concern; this only
    /// pins that a zero-length array survives it like any other).
    @Fact
    func NoInitializerZeroLengthArray_BoxedToObject_ExecutesWithCorrectRuntimeIdentity() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4247_boxed_object_").FullName
        try {
            const Source = `import System
enum Kind { First = 7 }
var values = [0]Kind
var boxed object = values
Console.WriteLine(boxed.GetType().Name)
let back = (boxed as []Kind)!!
Console.WriteLine(back.Length)`
            let appPath = Path.Combine(tempDir, "Program.dll")
            let log = Compile(tempDir, "Program.gs", Source, appPath, "/target:exe")
            Assert.True(ErrorIds(log).Length == 0, log)
            Assert.True(File.Exists(appPath), log)
            IlVerifier.Verify(appPath)
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the emitted program must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"Kind[]", "0"}, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Parity control: the explicit empty-initializer spelling must keep
    /// working identically (this is the shape the issue says already
    /// worked "after the scoped serialization fix" — #4245/#4249).
    @Fact
    func ExplicitEmptyInitializer_StillCompilesAndReifiesAsEmptyArray() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4247_explicit_empty_").FullName
        try {
            const Source = `package P
import System
enum Kind { First = 7 }
class EAttribute(Values []Kind) : Attribute {}
@E([]Kind{})
class Target {}
Console.WriteLine("ok")`
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.True(ErrorIds(log).Length == 0, log)
            Assert.True(File.Exists(appPath), log)
            IlVerifier.Verify(appPath)
            let (argumentType, values) = ReadArrayArgument(appPath, "Target")
            Assert.Equal("P.Kind[]", argumentType)
            Assert.Empty(values)
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the emitted program must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal("ok", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A nonzero constant length with no initializer has no element list to
    /// serialize and must keep reporting GS0202 — the fix is scoped to the
    /// zero-length case, not a general default-value-filled allocation.
    @Fact
    func NonzeroLengthWithNoInitializer_StillRejected() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4247_nonzero_len_").FullName
        try {
            const Source = `package P
import System
enum Kind { First = 7 }
class EAttribute(Values []Kind) : Attribute {}
@E([3]Kind)
class Target {}
Console.WriteLine("ok")`
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.Contains("GS0202", ErrorIds(log))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A nonconstant length (a variable) with no initializer must keep
    /// reporting GS0202 — only a literal-constant zero length is accepted.
    @Fact
    func NonconstantLengthWithNoInitializer_StillRejected() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4247_nonconst_len_").FullName
        try {
            const Source = `package P
import System
enum Kind { First = 7 }
class EAttribute(Values []Kind) : Attribute {}
func Length() int32 { return 0 }
@E([Length()]Kind)
class Target {}
Console.WriteLine("ok")`
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.Contains("GS0202", ErrorIds(log))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private func ReadArrayArgument(assemblyPath string, typeName string)(ArgumentType string, Values[]object) {
            let paths = List[string](TrustedPlatformAssemblies()){assemblyPath}
            using let context = MetadataLoadContext(PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)))
            let assembly = context.LoadFromAssemblyPath(assemblyPath)
            let target = assembly.GetTypes().Single((candidate Type) -> candidate.Name == typeName)
            let attribute = target.GetCustomAttributesData().Single(
                (candidate CustomAttributeData) -> candidate.AttributeType.Name == "EAttribute"
            )
            let arrayArgument = attribute.ConstructorArguments.Single()
            let elements = Assert.IsAssignableFrom[IReadOnlyCollection[CustomAttributeTypedArgument]](
                arrayArgument.Value
            )
            let values = elements.Select((element CustomAttributeTypedArgument) -> element.Value!!).ToArray()
            return (arrayArgument.ArgumentType.FullName!!, values)
        }

        private func ErrorIds(log string)[]string -> Regex
            .Matches(log, "error (GS[0-9]{4})")
            .Select((match Match) -> match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .ToArray()

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)
            return tpa!!.Split(Path.PathSeparator)
        }

        private const RunTimeoutMilliseconds int32 = 60_000

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            // Draining stdout to EOF before touching stderr deadlocks if the child
            // fills the stderr pipe first — read both concurrently and bound the
            // wait, or a hanging/misbehaving program takes the whole test run
            // down with it (mirrors Issue3958NullableDirectionalChannelTests).
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeoutMilliseconds) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeoutMilliseconds / 1000}s (deadlock).")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }
    }
}
