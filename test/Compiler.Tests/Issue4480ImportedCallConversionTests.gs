// <copyright file="Issue4480ImportedCallConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Security.Cryptography
import System.Text
import System.Text.RegularExpressions
import System.Threading
import Xunit
import Xunit.Abstractions

/// Issue #4480: imported candidates are ranked on erased CLR shapes, but the
/// winning argument must still obey ADR-0186 §3 rule 3 when rebound against
/// its nullability-aware parameter type.
/// @remarks The fixture is compiled by Roslyn because its two halves deliberately use
/// different C# nullable contexts: `Ob` produces
/// `List[string!]!`, while `Calls.Required` consumes
/// `IEnumerable[string]` and `Calls.Nullable` consumes
/// `IEnumerable[string?]`.
///
/// <b>Discrimination (ADR-0154).</b> On parent commit
/// `19ed00e5abeab6164100cfab611ed3777b0f4648`, all imported rejection
/// rows compile successfully while the G# parity row already reports GS0154.
/// The accepting rows compile on both sides. Reverting the product guard
/// restores that exact red/green split.
///
/// Restoring the former raw-CLR-type prerequisite independently makes the
/// same-compilation `Repo[T]` imported-call row compile, proving that
/// canonical supertype projection—not CLR backing—is required there.
@Collection("Issue4480Console")
open class Issue4480ImportedCallConversionTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    /// Rule 3 is enforced equally at imported and G# callees.
    @Theory
    @MemberData("RejectedCases")
    func Rule3Mismatch_ReportsGs0154AtArgument(name string, source string, line int32, parameterName string) {
        using let fixture = Issue4480ImportedCallConversionTests.Fixture(name)
        let log = fixture.Compile(source)
        Assert.Contains("App.gs($line,", log, StringComparison.Ordinal)
        Assert.Contains("GS0154", log, StringComparison.Ordinal)
        Assert.Contains("Parameter '$parameterName'", log, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal)
    }

    /// Nullable element destinations, value-type elements, inferred generic
    /// slots, and `String.Join(IEnumerable<string?>)` remain valid.
    @Fact
    func LegalImportedControls_StillCompile() {
        const source = `package P
import System
import Issue4480.Library

Console.WriteLine(Calls.Nullable(Ob.Strings()))
Console.WriteLine(String.Join(",", Ob.Strings()))
Console.WriteLine(Calls.Value(Ob.Ints()))
Console.WriteLine(Calls.Generic(Ob.Name()))
Console.WriteLine(Calls.GenericSequence(Ob.Strings()))`
        using let fixture = Issue4480ImportedCallConversionTests.Fixture("controls")
        let log = fixture.Compile(source)
        Assert.True(File.Exists(fixture.AppPath), log)
        Assert.DoesNotContain("GS0154", log, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0155", log, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0159", log, StringComparison.Ordinal)
    }

    /// An unrelated invariant owner is a type mismatch, not a nullability-only mismatch.
    @Fact
    func ProjectedUnrelatedSibling_DoesNotBecomeGs0154() {
        const source = `package P
import Issue4480.Library

class A {
}
class B {
}
class Repo[TFirst, TSecond] : IPair[TFirst, TSecond] {
    private let second TSecond
    init(first TFirst, second TSecond) {
        this.second = second
    }
    func GetSecond() TSecond -> second
}

let count = GenericCalls[B].RequiredPair(Repo(Ob.Strings()[0], A()))`
        using let fixture = Issue4480ImportedCallConversionTests.Fixture("projected-unrelated")
        const oracle = `using Issue4480.Library;
class A {}
class B {}
class Repo<TFirst,TSecond> : IPair<TFirst,TSecond> {
    TSecond second;
    public Repo(TFirst first,TSecond second) { this.second=second; }
    public TSecond GetSecond() => second;
}
class Program {
    static void Main() {
        GenericCalls<B>.RequiredPair(new Repo<string,A>(Ob.Strings()[0],new A()));
    }
}
`
        output.WriteLine("Contract source:\n" + LibrarySource)
        output.WriteLine("Oracle source:\n" + oracle)
        output.WriteLine("G# source:\n" + source)
        output.WriteLine("SHA256 source: " + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source))))
        output.WriteLine(
            "SHA256 Issue4480.Library.dll: " + Convert.ToHexString(
                SHA256.HashData(File.ReadAllBytes(fixture.ContractPath))
            )
        )
        fixture.RejectCSharp(oracle)
        let log = fixture.Compile(source, emitArtifacts: true)
        output.WriteLine(log)
        Assert.False(File.Exists(fixture.AppPath), log)
        Assert.False(File.Exists(Path.ChangeExtension(fixture.AppPath, "ref.dll")), log)
        Assert.False(File.Exists(Path.ChangeExtension(fixture.AppPath, "pdb")), log)
        Assert.Single(Regex.Matches(log, ": error GS\\d+:"))
        Assert.Contains("App.gs(16,42,16,68): error GS0490:", log, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0154", log, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal)
    }

    /// A nullable closed generic base target preserves rule-2 widening.
    @Fact
    func NullableGenericBaseTarget_StillCompiles() {
        const source = `package P
import System.Collections.Generic
import Issue4480.Library

class Derived : GenericBase[IEnumerable[string?]] {
    init() : base(Ob.Strings()) { }
}`
        using let fixture = Issue4480ImportedCallConversionTests.Fixture("nullable-generic-base")
        let log = fixture.Compile(source)
        Assert.True(File.Exists(fixture.AppPath), log)
        Assert.DoesNotContain("GS0154", log, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0155", log, StringComparison.Ordinal)
    }

    private class Fixture : IDisposable {
        private let root string
        private let libraryPath string

        init(name string) {
            root = Path.Combine(AppContext.BaseDirectory, "issue4480-" + name + "-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            libraryPath = CompileCSharpLibrary(root)
            AppPath = Path.Combine(root, "App.dll")
        }

        prop AppPath string {
            get;
        }

        prop ContractPath string -> libraryPath

        func RejectCSharp(source string) {
            let references = TrustedPlatformAssemblies().Append(libraryPath).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Oracle",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.ConsoleApplication)
            )
            using let stream = MemoryStream()
            let result = compilation.Emit(stream)
            Assert.False(result.Success)
            Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "CS1503")
        }

        func Compile(source string, emitArtifacts bool = false) string {
            let sourcePath = Path.Combine(root, "App.gs")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + AppPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + libraryPath
            }
            if emitArtifacts {
                args.Add("/refout:" + Path.ChangeExtension(AppPath, "ref.dll"))
                args.Add("/debug:portable")
            }
            args.AddRange(TrustedPlatformAssemblies().Select((path string) -> ("/reference:" + path)))
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return stdout.ToString() + stderr.ToString()
        }

        func Dispose() {
            for var attempt = 0; attempt < 3; attempt++ {
                try {
                    Directory.Delete(root, recursive: true)
                    return
                } catch (ex Exception) when ex is IOException || ex is UnauthorizedAccessException {
                    if attempt == 2 {
                        Console.Error.WriteLine("Could not delete test directory '$root': ${ex.Message}")
                        return
                    }
                    Thread.Sleep(50 * (attempt + 1))
                }
            }
        }

        shared {
            private func CompileCSharpLibrary(root string) string {
                let references = TrustedPlatformAssemblies().Select(
                    (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
                )
                let compilation = CSharpCompilation.Create(
                    "Issue4480.Library",
                    []SyntaxTree{CSharpSyntaxTree.ParseText(Issue4480ImportedCallConversionTests.LibrarySource)},
                    references,
                    CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithDeterministic(true)
                        .WithNullableContextOptions(NullableContextOptions.Enable)
                )
                let path = Path.Combine(root, "Issue4480.Library.dll")
                let result = compilation.Emit(path)
                Assert.True(
                    result.Success,
                    string.Join(
                        Environment.NewLine,
                        result.Diagnostics.Where(
                            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
                        )
                    )
                )
                return path
            }

            private func TrustedPlatformAssemblies() IEnumerable[string] {
                let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
                return if string.IsNullOrEmpty(tpa) {
                    Enumerable.Empty[string]()
                } else {
                    tpa!!.Split(Path.PathSeparator).Where(File.Exists)
                }
            }
        }
    }

    /// Serializes tests that temporarily redirect process-wide console output.
    @CollectionDefinition("Issue4480Console", DisableParallelization = true)
    class Issue4480ConsoleCollection { }

    shared {
        private const LibrarySource string = `using System.Collections.Generic;
using System.Linq;

namespace Issue4480.Library;

#nullable disable
public static class Ob
{
    public static List<string> Strings() => new() { "ok", null };

    public static List<int> Ints() => new() { 1, 2 };

    public static string Name() => "ok";
}

#nullable enable
public static class Calls
{
    public static int Required(IEnumerable<string> values) => values.Count();

    public static int RequiredIn(in IEnumerable<string> values) => values.Count();

    public static int RequiredMany(params IEnumerable<string>[] values) => values.Length;

    public static int RequiredNamed(
        int marker,
        IEnumerable<string> values,
        params int[] tail) => marker + values.Count() + tail.Length;

    public static int Nullable(IEnumerable<string?> values) => values.Count();

    public static int Value(IEnumerable<int> values) => values.Count();

    public static int Generic<T>(T value) => value is null ? 0 : 1;

    public static int GenericSequence<T>(IEnumerable<T> values) => values.Count();
}

public static class GenericCalls<T>
{
    public static int Required(IEnumerable<string> values) => values.Count();

    public static int RequiredIn(in IEnumerable<string> values) => values.Count();

    public static int RequiredPair(IPair<string, T> values) => 0;
}

public interface ITaker<T>
{
    int Required(T values);
}

public sealed class Taker : ITaker<IEnumerable<string>>
{
    public int Required(IEnumerable<string> values) => values.Count();
}

public interface IStaticTaker<TSelf, T>
    where TSelf : IStaticTaker<TSelf, T>
{
    static abstract int Required(T values);
}

public sealed class StaticTaker : IStaticTaker<StaticTaker, IEnumerable<string>>
{
    public static int Required(IEnumerable<string> values) => values.Count();
}

public interface IInstanceCalls
{
    int Required(IEnumerable<string> values);
}

public sealed class InstanceCalls : IInstanceCalls
{
    public int Required(IEnumerable<string> values) => values.Count();
}

public interface IStaticCalls<TSelf>
    where TSelf : IStaticCalls<TSelf>
{
    static abstract int Required(IEnumerable<string> values);
}

public sealed class StaticCalls : IStaticCalls<StaticCalls>
{
    public static int Required(IEnumerable<string> values) => values.Count();
}

public class RequiredBase
{
    public RequiredBase(IEnumerable<string> values) { }
}

public class RequiredParamsBase
{
    public RequiredParamsBase(params IEnumerable<string>[] values) { }
}

public class RequiredParams
{
    public RequiredParams(params IEnumerable<string>[] values) { }
}

public class GenericBase<T>
{
    public GenericBase(T values) { }
}

public sealed class Pair<TFirst, TSecond>
{
}

public interface IPair<TFirst, TSecond>
{
    TSecond GetSecond();
}

public static class MixedCalls
{
    public static int Required(
#nullable disable
        Pair<string,
#nullable enable
        string> values) => 0;
}

#nullable enable
public static class MixedOb
{
    public static Pair<
        string,
#nullable disable
        string> Pair() => new();

}`

        /// Calls whose resolved imported parameter rejects rule 3.
        /// @returns Name, source, diagnostic line, and parameter name.
        func RejectedCases() sequence[[]object] {
            yield[]object{"imported-call", `package P
import Issue4480.Library

let xs = Ob.Strings()
let count = Calls.Required(xs)`, 5, "values"}
            yield[]object{"imported-constructor", `package P
import System.Collections.Generic
import Issue4480.Library

let copy = List[string](Ob.Strings())`, 5, "collection"}
            yield[]object{"imported-in-call", `package P
import Issue4480.Library

let xs = Ob.Strings()
let count = Calls.RequiredIn(xs)`, 5, "values"}
            yield[]object{"imported-expanded-call", `package P
import Issue4480.Library

let count = Calls.RequiredMany(Ob.Strings())`, 4, "values"}
            yield[]object{"imported-expanded-constructor", `package P
import Issue4480.Library

let value = RequiredParams(Ob.Strings())`, 4, "values"}
            yield[]object{"imported-mixed-nullability-call", `package P
import Issue4480.Library

let count = MixedCalls.Required(MixedOb.Pair())`, 4, "values"}
            yield[]object{"imported-expanded-named-call", `package P
import Issue4480.Library

let count = Calls.RequiredNamed(
    values: Ob.Strings(),
    marker: 0)`, 5, "values"}
            yield[]object{"gsharp-parity", `package P
import System.Collections.Generic
import Issue4480.Library

func Required(values IEnumerable[string]) int32 -> values.Count()
let count = Required(Ob.Strings())`, 6, "values"}
            yield[]object{"constrained-instance-call", `package P
import System.Collections.Generic
import Issue4480.Library

func Via[T IInstanceCalls](receiver T) int32 {
    return receiver.Required(Ob.Strings())
}
let count = Via[InstanceCalls](InstanceCalls())`, 6, "values"}
            yield[]object{"constrained-static-call", `package P
import System.Collections.Generic
import Issue4480.Library

func Via[T IStaticCalls[T]]() int32 {
    return T.Required(Ob.Strings())
}
let count = Via[StaticCalls]()`, 6, "values"}
            yield[]object{"imported-base-constructor", `package P
import Issue4480.Library

class Derived : RequiredBase {
    init() : base(Ob.Strings()) { }
}`, 5, "values"}
            yield[]object{"imported-expanded-base-constructor", `package P
import Issue4480.Library

class Derived : RequiredParamsBase {
    init() : base(Ob.Strings(), Ob.Strings()) { }
}`, 5, "values"}
            yield[]object{"source-container-imported-call", `package P
import System.Collections
import System.Collections.Generic
import Issue4480.Library

class Repo[T] : IEnumerable[T] {
    private let items List[T] = List[T]()
    init(value T) { items.Add(value) }
    func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}

let count = Calls.Required(Repo(Ob.Strings()[0]))`, 13, "values"}
            yield[]object{"symbolic-static-receiver", `package P
import Issue4480.Library

func Probe[T]() int32 -> GenericCalls[T].Required(Ob.Strings())
let count = Probe[int32]()`, 4, "values"}
            yield[]object{"symbolic-static-receiver-in", `package P
import Issue4480.Library

func Probe[T]() int32 -> GenericCalls[T].RequiredIn(Ob.Strings())
let count = Probe[int32]()`, 4, "values"}
            yield[]object{"constrained-generic-instance-slot", `package P
import System.Collections.Generic
import Issue4480.Library

func Probe[R ITaker[IEnumerable[string]]](receiver R) int32 -> receiver.Required(Ob.Strings())
let count = Probe(Taker())`, 5, "values"}
            yield[]object{"constrained-generic-static-slot", `package P
import System.Collections.Generic
import Issue4480.Library

func Probe[R IStaticTaker[R, IEnumerable[string]]]() int32 -> R.Required(Ob.Strings())
let count = Probe[StaticTaker]()`, 5, "values"}
        }
    }
}
