// <copyright file="Issue4480ImportedCallConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4480: imported candidates are ranked on erased CLR shapes, but the
/// winning argument must still obey ADR-0186 §3 rule 3 when rebound against
/// its nullability-aware parameter type.
/// </summary>
/// <remarks>
/// <para>
/// The fixture is compiled by Roslyn because its two halves deliberately use
/// different C# nullable contexts: <c>Ob</c> produces
/// <c>List[string!]!</c>, while <c>Calls.Required</c> consumes
/// <c>IEnumerable[string]</c> and <c>Calls.Nullable</c> consumes
/// <c>IEnumerable[string?]</c>.
/// </para>
/// <para>
/// <b>Discrimination (ADR-0154).</b> On parent commit
/// <c>19ed00e5abeab6164100cfab611ed3777b0f4648</c>, all imported rejection
/// rows compile successfully while the G# parity row already reports GS0154.
/// The accepting rows compile on both sides. Reverting the product guard
/// restores that exact red/green split.
/// </para>
/// <para>
/// Restoring the former raw-CLR-type prerequisite independently makes the
/// same-compilation <c>Repo[T]</c> imported-call row compile, proving that
/// canonical supertype projection—not CLR backing—is required there.
/// </para>
/// </remarks>
[Collection("Issue4480Console")]
public class Issue4480ImportedCallConversionTests
{
    private const string LibrarySource = """
        using System.Collections.Generic;
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

        }
        """;

    /// <summary>Calls whose resolved imported parameter rejects rule 3.</summary>
    /// <returns>Name, source, diagnostic line, and parameter name.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        yield return new object[]
        {
            "imported-call",
            """
            package P
            import Issue4480.Library

            let xs = Ob.Strings()
            let count = Calls.Required(xs)
            """,
            5,
            "values",
        };

        yield return new object[]
        {
            "imported-constructor",
            """
            package P
            import System.Collections.Generic
            import Issue4480.Library

            let copy = List[string](Ob.Strings())
            """,
            5,
            "collection",
        };

        yield return new object[]
        {
            "imported-in-call",
            """
            package P
            import Issue4480.Library

            let xs = Ob.Strings()
            let count = Calls.RequiredIn(xs)
            """,
            5,
            "values",
        };

        yield return new object[]
        {
            "imported-expanded-call",
            """
            package P
            import Issue4480.Library

            let count = Calls.RequiredMany(Ob.Strings())
            """,
            4,
            "values",
        };

        yield return new object[]
        {
            "imported-expanded-constructor",
            """
            package P
            import Issue4480.Library

            let value = RequiredParams(Ob.Strings())
            """,
            4,
            "values",
        };

        yield return new object[]
        {
            "imported-mixed-nullability-call",
            """
            package P
            import Issue4480.Library

            let count = MixedCalls.Required(MixedOb.Pair())
            """,
            4,
            "values",
        };

        yield return new object[]
        {
            "imported-expanded-named-call",
            """
            package P
            import Issue4480.Library

            let count = Calls.RequiredNamed(
                values: Ob.Strings(),
                marker: 0)
            """,
            5,
            "values",
        };

        yield return new object[]
        {
            "gsharp-parity",
            """
            package P
            import System.Collections.Generic
            import Issue4480.Library

            func Required(values IEnumerable[string]) int32 -> values.Count()
            let count = Required(Ob.Strings())
            """,
            6,
            "values",
        };

        yield return new object[]
        {
            "constrained-instance-call",
            """
            package P
            import System.Collections.Generic
            import Issue4480.Library

            func Via[T IInstanceCalls](receiver T) int32 {
                return receiver.Required(Ob.Strings())
            }
            let count = Via[InstanceCalls](InstanceCalls())
            """,
            6,
            "values",
        };

        yield return new object[]
        {
            "constrained-static-call",
            """
            package P
            import System.Collections.Generic
            import Issue4480.Library

            func Via[T IStaticCalls[T]]() int32 {
                return T.Required(Ob.Strings())
            }
            let count = Via[StaticCalls]()
            """,
            6,
            "values",
        };

        yield return new object[]
        {
            "imported-base-constructor",
            """
            package P
            import Issue4480.Library

            class Derived : RequiredBase {
                init() : base(Ob.Strings()) { }
            }
            """,
            5,
            "values",
        };

        yield return new object[]
        {
            "imported-expanded-base-constructor",
            """
            package P
            import Issue4480.Library

            class Derived : RequiredParamsBase {
                init() : base(Ob.Strings(), Ob.Strings()) { }
            }
            """,
            5,
            "values",
        };

        yield return new object[]
        {
            "source-container-imported-call",
            """
            package P
            import System.Collections
            import System.Collections.Generic
            import Issue4480.Library

            class Repo[T] : IEnumerable[T] {
                private let items List[T] = List[T]()
                init(value T) { items.Add(value) }
                func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
                private func GetEnumerator() IEnumerator -> GetEnumerator()
            }

            let count = Calls.Required(Repo(Ob.Strings()[0]))
            """,
            13,
            "values",
        };

        yield return new object[]
        {
            "symbolic-static-receiver",
            """
            package P
            import Issue4480.Library

            func Probe[T]() int32 -> GenericCalls[T].Required(Ob.Strings())
            let count = Probe[int32]()
            """,
            4,
            "values",
        };

        yield return new object[]
        {
            "symbolic-static-receiver-in",
            """
            package P
            import Issue4480.Library

            func Probe[T]() int32 -> GenericCalls[T].RequiredIn(Ob.Strings())
            let count = Probe[int32]()
            """,
            4,
            "values",
        };
    }

    /// <summary>Rule 3 is enforced equally at imported and G# callees.</summary>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void Rule3Mismatch_ReportsGs0154AtArgument(
        string name,
        string source,
        int line,
        string parameterName)
    {
        using var fixture = new Fixture(name);
        var log = fixture.Compile(source);

        Assert.Contains($"App.gs({line},", log, StringComparison.Ordinal);
        Assert.Contains("GS0154", log, StringComparison.Ordinal);
        Assert.Contains($"Parameter '{parameterName}'", log, StringComparison.Ordinal);
        Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal);
    }

    /// <summary>
    /// Nullable element destinations, value-type elements, inferred generic
    /// slots, and <c>String.Join(IEnumerable&lt;string?&gt;)</c> remain valid.
    /// </summary>
    [Fact]
    public void LegalImportedControls_StillCompile()
    {
        const string source = """
            package P
            import System
            import Issue4480.Library

            Console.WriteLine(Calls.Nullable(Ob.Strings()))
            Console.WriteLine(String.Join(",", Ob.Strings()))
            Console.WriteLine(Calls.Value(Ob.Ints()))
            Console.WriteLine(Calls.Generic(Ob.Name()))
            Console.WriteLine(Calls.GenericSequence(Ob.Strings()))
            """;

        using var fixture = new Fixture("controls");
        var log = fixture.Compile(source);

        Assert.True(File.Exists(fixture.AppPath), log);
        Assert.DoesNotContain("GS0154", log, StringComparison.Ordinal);
        Assert.DoesNotContain("GS0155", log, StringComparison.Ordinal);
        Assert.DoesNotContain("GS0159", log, StringComparison.Ordinal);
    }

    /// <summary>A nullable closed generic base target preserves rule-2 widening.</summary>
    [Fact]
    public void NullableGenericBaseTarget_StillCompiles()
    {
        const string source = """
            package P
            import System.Collections.Generic
            import Issue4480.Library

            class Derived : GenericBase[IEnumerable[string?]] {
                init() : base(Ob.Strings()) { }
            }
            """;

        using var fixture = new Fixture("nullable-generic-base");
        var log = fixture.Compile(source);

        Assert.True(File.Exists(fixture.AppPath), log);
        Assert.DoesNotContain("GS0154", log, StringComparison.Ordinal);
        Assert.DoesNotContain("GS0155", log, StringComparison.Ordinal);
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string root;
        private readonly string libraryPath;

        public Fixture(string name)
        {
            root = Path.Combine(
                AppContext.BaseDirectory,
                "issue4480-" + name + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            libraryPath = CompileCSharpLibrary(root);
            AppPath = Path.Combine(root, "App.dll");
        }

        public string AppPath { get; }

        public string Compile(string source)
        {
            var sourcePath = Path.Combine(root, "App.gs");
            File.WriteAllText(sourcePath, source);
            var args = new List<string>
            {
                "/out:" + AppPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + libraryPath,
            };
            args.AddRange(TrustedPlatformAssemblies().Select(path => "/reference:" + path));
            args.Add(sourcePath);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            return stdout.ToString() + stderr.ToString();
        }

        public void Dispose()
        {
            for (var attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    Directory.Delete(root, recursive: true);
                    return;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    if (attempt == 2)
                    {
                        Console.Error.WriteLine($"Could not delete test directory '{root}': {ex.Message}");
                        return;
                    }

                    Thread.Sleep(50 * (attempt + 1));
                }
            }
        }

        private static string CompileCSharpLibrary(string root)
        {
            var references = TrustedPlatformAssemblies()
                .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
            var compilation = CSharpCompilation.Create(
                "Issue4480.Library",
                new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                    .WithNullableContextOptions(NullableContextOptions.Enable));
            var path = Path.Combine(root, "Issue4480.Library.dll");
            var result = compilation.Emit(path);
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)));
            return path;
        }

        private static IEnumerable<string> TrustedPlatformAssemblies()
        {
            var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
            return string.IsNullOrEmpty(tpa)
                ? Enumerable.Empty<string>()
                : tpa.Split(Path.PathSeparator).Where(File.Exists);
        }
    }

    /// <summary>Serializes tests that temporarily redirect process-wide console output.</summary>
    [CollectionDefinition("Issue4480Console", DisableParallelization = true)]
    public sealed class Issue4480ConsoleCollection
    {
    }
}
