// <copyright file="GeneratedRegexImplementingPartTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;
using Xunit.Abstractions;
using static GSharp.GeneratorHost.Tests.StubTestSupport;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// ADR-0192 follow-on 2, steps 3 and 4: a G# <c>@GeneratedRegex</c> declaring
/// part drives the REAL Regex generator through the stub, and the
/// back-translated <c>.g.gs</c> carries the generated implementation as a G#
/// IMPLEMENTING part (<c>partial func</c> with its body) that pairs with it.
/// Step 4: the generator's helper types keep their own package (no collision
/// with user types), and the implementing part is spelled with the user's own
/// header so a differently spelled declaring part still pairs.
/// </summary>
public class GeneratedRegexImplementingPartTests
{
    private const string UserSourceTemplate = @"package App

import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex(ARGUMENTS)
        private partial func Digits() Regex;

        public func Test(s string) bool {
            return Digits().IsMatch(s)
        }

        public func Kind() string {
            return Digits().GetType().FullName!!
        }
    }
}
";

    private const string GeneratedPackage = "System.Text.RegularExpressions.Generated";

    private readonly ITestOutputHelper output;

    public GeneratedRegexImplementingPartTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    // The patterns span the generator's shapes: a simple loop, captures with
    // options, and a backtracking alternation whose C# passes
    // `ref base.runstack!` (a by-ref argument under `!`).
    [Theory]
    [InlineData(@"""\\d+""", "a1")]
    [InlineData(@"""^(?<y>\\d{4})-(?<m>\\d{2})$"", RegexOptions.IgnoreCase", "2024-05")]
    [InlineData(@"""(foo|ba+r)+\\w*?baz"", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase", "xxFOObaarQQbaz")]
    public void RealRegexGenerator_BackTranslatesToAnImplementingPart_ThatCompilesAndRuns(string arguments, string match)
    {
        string userSource = UserSourceTemplate.Replace("ARGUMENTS", arguments, StringComparison.Ordinal);
        Run run = this.GenerateAndCompile(new[] { userSource }, RegexGenerator());

        string userPart = run.File("RegexGenerator.g.cs");
        Assert.Contains("package App", userPart, StringComparison.Ordinal);
        Assert.Contains("private partial func Digits() Regex -> Digits_0.Instance", userPart, StringComparison.Ordinal);
        Assert.Contains("import " + GeneratedPackage, userPart, StringComparison.Ordinal);

        Type p = run.Type("P");
        Assert.Equal(true, Invoke(p, "Test", match));
        Assert.Equal(false, Invoke(p, "Test", "zzz"));
        Assert.StartsWith(GeneratedPackage + ".", (string)Invoke(p, "Kind"), StringComparison.Ordinal);
    }

    // Step 4: the generator's `file` helper types (`Digits_0`, `Utilities`,
    // `RunnerFactory`, the `IndexOfAny*` extension funcs) come out in their
    // own package, so a user type named `Utilities` no longer collides with
    // them (it was GS0102, with the helpers' members then unresolvable).
    [Fact]
    public void GeneratedHelpers_KeepTheirOwnPackage_SoAUserUtilitiesTypeDoesNotCollide()
    {
        string userSource = UserSourceTemplate.Replace("ARGUMENTS", @"""\\d+""", StringComparison.Ordinal)
            + @"
class Utilities {
    public func Name() string {
        return ""user utilities""
    }
}
";
        Run run = this.GenerateAndCompile(new[] { userSource }, RegexGenerator());

        string userPart = run.File("RegexGenerator.g.cs");
        string helpers = run.File("RegexGenerator.System_Text_RegularExpressions_Generated.g.cs");
        Assert.DoesNotContain("class Utilities", userPart, StringComparison.Ordinal);
        Assert.StartsWith("package " + GeneratedPackage, helpers, StringComparison.Ordinal);
        Assert.Contains("internal class Digits_0", helpers, StringComparison.Ordinal);
        Assert.Contains("class Utilities", helpers, StringComparison.Ordinal);
        Assert.DoesNotContain("import " + GeneratedPackage, helpers, StringComparison.Ordinal);

        Type p = run.Type("P");
        Assert.Equal(true, Invoke(p, "Test", "a1"));
        Assert.Equal(GeneratedPackage + ".Digits_0", Invoke(p, "Kind"));
    }

    // Two user packages that each use the generator: the generator emits ONE
    // file with one `Generated` namespace, so there is exactly one set of
    // helper types, shared by both packages' implementing parts.
    [Fact]
    public void TwoUserPackages_ShareOneHelperPackage()
    {
        string app = UserSourceTemplate.Replace("ARGUMENTS", @"""\\d+""", StringComparison.Ordinal);
        const string Lib = @"package Lib

import System.Text.RegularExpressions

partial class Q {
    shared {
        @GeneratedRegex(""^[a-z]+$"", RegexOptions.IgnoreCase)
        internal partial func Word() Regex;

        public func Test(s string) bool {
            return Word().IsMatch(s)
        }
    }
}
";
        Run run = this.GenerateAndCompile(new[] { app, Lib }, RegexGenerator());

        Assert.Equal(3, run.Files.Count);
        Assert.Contains("package Lib", run.File("RegexGenerator.Lib.g.cs"), StringComparison.Ordinal);
        int utilities = run.Files.Sum(file => CountOccurrences(file.Source, "class Utilities"));
        Assert.Equal(1, utilities);

        Assert.Equal(true, Invoke(run.Type("P"), "Test", "a1"));
        Assert.Equal(true, Invoke(run.Type("Q"), "Test", "HeLLo"));
        Assert.Equal(false, Invoke(run.Type("Q"), "Test", "he llo"));
    }

    // Step 4: pairing is textual (GS0611), so the implementing part is spelled
    // with the declaring part's own header — here a fully qualified return
    // type the back-translation would have shortened to `Regex`.
    [Fact]
    public void DifferentlySpelledHeader_IsCopiedIntoTheImplementingPart()
    {
        string userSource = UserSourceTemplate
            .Replace("ARGUMENTS", @"""\\d+""", StringComparison.Ordinal)
            .Replace("private partial func Digits() Regex;", "private partial func Digits() System.Text.RegularExpressions.Regex;", StringComparison.Ordinal);
        Run run = this.GenerateAndCompile(new[] { userSource }, RegexGenerator());

        Assert.Contains(
            "private partial func Digits() System.Text.RegularExpressions.Regex -> Digits_0.Instance",
            run.File("RegexGenerator.g.cs"),
            StringComparison.Ordinal);
        Assert.Equal(true, Invoke(run.Type("P"), "Test", "a1"));
    }

    // A declaring part spelled with an alias the user's file imports: the
    // alias import is brought into the .g.gs so the copied header binds.
    [Fact]
    public void AliasSpelledHeader_BringsTheAliasImport()
    {
        const string UserSource = @"package App

import System.Text.RegularExpressions
import Rx = System.Text.RegularExpressions.Regex

partial class P {
    shared {
        @GeneratedRegex(""\\d+"")
        private partial func Digits() Rx;

        public func Test(s string) bool {
            return Digits().IsMatch(s)
        }
    }
}
";
        Run run = this.GenerateAndCompile(new[] { UserSource }, RegexGenerator());

        string userPart = run.File("RegexGenerator.g.cs");
        Assert.Contains("import Rx = System.Text.RegularExpressions.Regex", userPart, StringComparison.Ordinal);
        Assert.Contains("private partial func Digits() Rx -> Digits_0.Instance", userPart, StringComparison.Ordinal);
        Assert.Equal(true, Invoke(run.Type("P"), "Test", "a1"));
    }

    // A parameter type spelled `int` where the back-translated C# `int` would
    // be `int32` (the `@LoggerMessage` shape): GS0264/GS0610/GS0609 before.
    [Fact]
    public void ParameterTypeAliasSpelling_IsCopiedIntoTheImplementingPart()
    {
        const string UserSource = @"package App

partial class Calc {
    shared {
        public partial func Twice(count int) int;
    }
}
";
        Run run = this.GenerateAndCompile(new[] { UserSource }, new PartialImplementationGenerator(renameParameters: false));

        Assert.Contains("public partial func Twice(count int) int", run.Files.Single().Source, StringComparison.Ordinal);
        Assert.Equal(42, Invoke(run.Type("Calc"), "Twice", 21));
    }

    // Copilot review (#4430): the owning type's generic arity is part of the
    // match. `P` and `P[T]` both declare `Twice` with one parameter; matched on
    // name alone, each implementation fits both declaring parts, nothing is
    // copied, and the `int` headers fail to pair with the generated `int32`.
    [Fact]
    public void SameNamedTypesOfDifferentArity_EachGetTheirOwnHeader()
    {
        const string UserSource = @"package App

partial class Calc {
    shared {
        public partial func Twice(count int) int;
    }
}

partial class Calc[T] {
    shared {
        public partial func Twice(count int) int;
    }
}
";
        Run run = this.GenerateAndCompile(new[] { UserSource }, new PartialImplementationGenerator(renameParameters: false));

        Assert.Equal(2, CountOccurrences(run.Files.Single().Source, "public partial func Twice(count int) int"));
        Assert.Equal(42, Invoke(run.Assembly.GetTypes().Single(type => type.Name == "Calc"), "Twice", 21));
    }

    // Copilot review (#4430): headers are compared token by token, the way
    // gsc's pairing check compares them, so whitespace inside a literal
    // counts. The generated default "a b" and the declared "a  b" differ, so
    // the declared header is copied; a character-level whitespace collapse
    // treated them as equal, skipped the copy, and gsc reported GS0611.
    [Fact]
    public void LiteralWhitespace_InADefaultValue_IsNotNormalizedAway()
    {
        const string UserSource = @"package App

partial class Calc {
    shared {
        partial func Greet(name string = ""a  b"") int32;
    }
}
";
        Run run = this.GenerateAndCompile(new[] { UserSource }, new PartialImplementationGenerator(renameParameters: false));

        Assert.Contains("partial func Greet(name string = \"a  b\") int32", run.Files.Single().Source, StringComparison.Ordinal);
    }

    // Copilot review (#4430): an alias import copied for the header keeps its
    // G# spelling. The target's `$class` segment is a keyword escape; spelled
    // by value it printed `import K = class.Mark`, which does not parse.
    // The alias names a parameter annotation, which the generated
    // implementation does not restate, so the header must be copied.
    [Fact]
    public void CopiedAliasImport_KeepsKeywordEscapes()
    {
        const string KeywordPackage = @"package $class

class Mark : System.Attribute {
}
";
        const string UserSource = @"package App

import K = $class.Mark

partial class Calc {
    shared {
        public partial func Twice(@K count int32) int32;
    }
}
";
        Run run = this.GenerateAndCompile(new[] { KeywordPackage, UserSource }, new PartialImplementationGenerator(renameParameters: false));

        string generated = run.Files.Single().Source;
        Assert.Contains("import K = $class.Mark", generated, StringComparison.Ordinal);
        Assert.Contains("public partial func Twice(@K count int32) int32", generated, StringComparison.Ordinal);
        Assert.Equal(42, Invoke(run.Type("Calc"), "Twice", 21));
    }

    // Copilot review (#4430): only a bare name or the LEFTMOST segment of a
    // qualified name can resolve through an alias. `Regex` here is the last
    // segment of `System.Text.RegularExpressions.Regex`, so the unused alias
    // `Regex` must not be copied into the .g.gs.
    [Fact]
    public void AliasNamedLikeATrailingSegment_IsNotCopied()
    {
        const string UserSource = @"package App

import System.Text.RegularExpressions
import Regex = System.Text.StringBuilder

partial class P {
    shared {
        @GeneratedRegex(""\\d+"")
        private partial func Digits() System.Text.RegularExpressions.Regex;

        public func Test(s string) bool {
            return Digits().IsMatch(s)
        }
    }
}
";
        Run run = this.GenerateAndCompile(new[] { UserSource }, RegexGenerator());

        string userPart = run.File("RegexGenerator.g.cs");
        Assert.Contains("private partial func Digits() System.Text.RegularExpressions.Regex ->", userPart, StringComparison.Ordinal);
        Assert.DoesNotContain("import Regex =", userPart, StringComparison.Ordinal);
        Assert.Equal(true, Invoke(run.Type("P"), "Test", "a1"));
    }

    // The leading segment of a qualified name is what an alias resolves:
    // `R.Regex` needs `import R = System.Text.RegularExpressions`.
    [Fact]
    public void AliasAsTheLeadingSegment_IsCopied()
    {
        const string UserSource = @"package App

import System.Text.RegularExpressions
import R = System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex(""\\d+"")
        private partial func Digits() R.Regex;

        public func Test(s string) bool {
            return Digits().IsMatch(s)
        }
    }
}
";
        Run run = this.GenerateAndCompile(new[] { UserSource }, RegexGenerator());

        string userPart = run.File("RegexGenerator.g.cs");
        Assert.Contains("import R = System.Text.RegularExpressions", userPart, StringComparison.Ordinal);
        Assert.Contains("private partial func Digits() R.Regex ->", userPart, StringComparison.Ordinal);
        Assert.Equal(true, Invoke(run.Type("P"), "Test", "a1"));
    }

    // Copilot review (#4430): only the names a header REFERENCES can need an
    // alias. Two files of one partial class carry unused aliases named like
    // their parameter (`count`) that disagree; neither header uses them, so
    // both headers are copied and nothing is reported.
    [Fact]
    public void UnusedAliasNamedLikeAParameter_IsNotRequired()
    {
        const string First = @"package App

import count = System.Text

partial class Calc {
    shared {
        public partial func Twice(count int) int;
    }
}
";
        const string Second = @"package App

import count = System.IO

partial class Calc {
    shared {
        public partial func Thrice(count int) int;
    }
}
";
        Run run = this.GenerateAndCompile(new[] { First, Second }, new PartialImplementationGenerator(renameParameters: false));

        string generated = run.Files.Single().Source;
        Assert.Contains("public partial func Twice(count int) int", generated, StringComparison.Ordinal);
        Assert.Contains("public partial func Thrice(count int) int", generated, StringComparison.Ordinal);
        Assert.DoesNotContain("import count", generated, StringComparison.Ordinal);
    }

    // A generated implementation whose parameter names differ from the
    // declaring part's must not pair silently: copying the header would rebind
    // the body to the wrong names, so the header is left as generated, gsgen
    // reports GS9208 at the declaring part, and gsc reports GS0611.
    [Fact]
    public void ParameterNameMismatch_IsReported_NotCopied()
    {
        const string UserSource = @"package App

partial class Calc {
    shared {
        public partial func Sub(a int32, b int32) int32;
    }
}
";
        var user = new Compilation(GsSyntaxTree.Parse(SourceText.From(UserSource, "User.gs")));
        GeneratorHostResult result = GeneratorHostRunner.Run(
            user,
            CSharpProjectLoader.RuntimeReferences(),
            new IIncrementalGenerator[] { new PartialImplementationGenerator(renameParameters: true) });

        GeneratorHostDiagnostic diagnostic = Assert.Single(result.HostDiagnostics);
        this.output.WriteLine(diagnostic.Message);
        Assert.Equal("GS9208", diagnostic.Id);
        Assert.Equal("User.gs", diagnostic.Location.FileName);
        Assert.Contains("'aRenamed'", diagnostic.Message, StringComparison.Ordinal);

        (string hintName, string generated) = Assert.Single(result.GeneratedGsFiles);
        var combined = new Compilation(
            GsSyntaxTree.Parse(SourceText.From(UserSource, "User.gs")),
            GsSyntaxTree.Parse(SourceText.From(generated, hintName + ".gs")))
        {
            IsLibrary = true,
        };
        Assert.Contains(Errors(combined), error => error.StartsWith("GS0611", StringComparison.Ordinal));
    }

    // A partial class split across two files that alias `R` differently: each
    // header binds in its own file, but both are copied into one .g.gs with
    // one import scope. The second header is left as generated, and GS9208
    // names both user files rather than blaming the generated code.
    [Fact]
    public void AliasClashBetweenTwoUserFiles_IsReportedAgainstBothFiles()
    {
        const string First = @"package App

import System.Text.RegularExpressions
import R = System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex(""\\d+"")
        private partial func Digits() R.Regex;
    }
}
";
        const string Second = @"package App

import System.Text.RegularExpressions
import R = System.Text

partial class P {
    shared {
        @GeneratedRegex(""[a-z]+"")
        private partial func Word() R.RegularExpressions.Regex;
    }
}
";
        var user = new Compilation(ParseUser(new[] { First, Second }).ToArray());
        GeneratorHostResult result = GeneratorHostRunner.RunFromAnalyzerPaths(
            user,
            CSharpProjectLoader.RuntimeReferences(),
            new[] { RegexGenerator() });

        Assert.Empty(result.GeneratorDiagnostics);
        GeneratorHostDiagnostic diagnostic = Assert.Single(result.HostDiagnostics);
        this.output.WriteLine(diagnostic.Message);
        Assert.Equal("GS9208", diagnostic.Id);
        Assert.Equal("User1.gs", diagnostic.Location.FileName);
        Assert.Contains("'import R = System.Text' from 'User1.gs'", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains("from 'User0.gs', needs it as 'System.Text.RegularExpressions'", diagnostic.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("the generated code", diagnostic.Message, StringComparison.Ordinal);
    }

    // ADR-0192 follow-on 2 review: a generated document with two or more
    // named namespaces is split into one unit per namespace, and its
    // global-namespace declarations must land in one of them (the first, as
    // the unsplit translation hoisted them into a package) instead of matching
    // no unit's filter and vanishing. User code still reaches them.
    [Fact]
    public void GlobalDeclarations_OfASplitDocument_StayReachable()
    {
        const string UserSource = @"package App

import System

class Probe {
    shared {
        public func Value() int32 {
            return GlobalHelper.G + Gen.Utilities.U
        }
    }
}
";
        const string Generated = @"namespace Gen.Helpers.Deep { internal static class DeepHelper { public static int D => 3; } }
namespace Gen { internal static class Utilities { public static int U => 2; } }
internal static class GlobalHelper { public static int G => 7; }
";
        Run run = this.GenerateAndCompile(
            new[] { UserSource },
            new FixedSourceGenerator(("Impl.g.cs", Generated)));

        Assert.Equal(2, run.Files.Count);
        string primary = run.File("Impl.g.cs");
        Assert.StartsWith("package Gen\n", primary.Replace("\r\n", "\n", StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.Contains("class GlobalHelper", primary, StringComparison.Ordinal);
        Assert.Equal(1, run.Files.Sum(file => CountOccurrences(file.Source, "class GlobalHelper")));
        Assert.Equal(9, Invoke(run.Type("Probe"), "Value"));
    }

    // A split unit's file name never takes one a generator hint name owns:
    // `Mixed.cs`'s `Lib.B` unit would be `Mixed.Lib_B`, which the real
    // `Mixed.Lib_B.cs` owns, so the split unit gets a `.split` marker and the
    // result does not depend on write order.
    [Fact]
    public void SplitUnitName_NeverTakesAGeneratorHintName()
    {
        const string Mixed = @"namespace Lib.A { internal static class First { public static int V => 1; } }
namespace Lib.B { internal static class Second { public static int V => 2; } }
";
        const string Real = @"namespace Other { internal static class Third { public static int V => 3; } }
";
        var user = new Compilation(GsSyntaxTree.Parse(SourceText.From("package App\n", "User0.gs")));
        GeneratorHostResult result = GeneratorHostRunner.Run(
            user,
            CSharpProjectLoader.RuntimeReferences(),
            new IIncrementalGenerator[] { new FixedSourceGenerator(("Mixed.cs", Mixed), ("Mixed.Lib_B.cs", Real)) });

        Assert.Equal(
            new[] { "Mixed.Lib_B.cs", "Mixed.Lib_B.split.g.cs", "Mixed.cs" },
            result.GeneratedGsFiles.Select(file => file.HintName).OrderBy(name => name, StringComparer.Ordinal).ToArray());
        Assert.Contains("package Other", result.GeneratedGsFiles.Single(file => file.HintName == "Mixed.Lib_B.cs").GSharpSource, StringComparison.Ordinal);
        Assert.Contains("package Lib.B", result.GeneratedGsFiles.Single(file => file.HintName == "Mixed.Lib_B.split.g.cs").GSharpSource, StringComparison.Ordinal);
    }

    private static string RegexGenerator() => RegexGeneratorPath();

    private static object Invoke(Type type, string method, params object[] arguments) =>
        type.GetMethod(method, BindingFlags.Public | BindingFlags.Static).Invoke(null, arguments);

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        for (int index = text.IndexOf(value, StringComparison.Ordinal); index >= 0; index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    private static List<string> Errors(Compilation compilation) =>
        compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(diagnostic => diagnostic.IsError)
            .Select(diagnostic =>
                $"{diagnostic.Id} {diagnostic.Location.Text?.FileName}:{diagnostic.Location.StartLine + 1}: " +
                diagnostic.Message)
            .Distinct(StringComparer.Ordinal)
            .ToList();

    private Run GenerateAndCompile(IReadOnlyList<string> userSources, string analyzerPath)
    {
        GeneratorHostResult result = GeneratorHostRunner.RunFromAnalyzerPaths(
            new Compilation(ParseUser(userSources).ToArray()),
            CSharpProjectLoader.RuntimeReferences(),
            new[] { analyzerPath });
        return this.Compile(userSources, result);
    }

    private Run GenerateAndCompile(IReadOnlyList<string> userSources, IIncrementalGenerator generator)
    {
        GeneratorHostResult result = GeneratorHostRunner.Run(
            new Compilation(ParseUser(userSources).ToArray()),
            CSharpProjectLoader.RuntimeReferences(),
            new[] { generator });
        return this.Compile(userSources, result);
    }

    private static List<GsSyntaxTree> ParseUser(IReadOnlyList<string> userSources) =>
        userSources
            .Select((source, index) => GsSyntaxTree.Parse(SourceText.From(source, "User" + index + ".gs")))
            .ToList();

    private Run Compile(IReadOnlyList<string> userSources, GeneratorHostResult result)
    {
        Assert.Empty(result.Failures);
        Assert.Empty(result.GeneratorDiagnostics);
        foreach (GeneratorHostDiagnostic diagnostic in result.HostDiagnostics)
        {
            this.output.WriteLine(diagnostic.Id + ": " + diagnostic.Message);
        }

        if (result.HostDiagnostics.Count > 0)
        {
            foreach ((string hintName, string source) in result.GeneratedGsFiles)
            {
                this.output.WriteLine("// " + hintName);
                this.output.WriteLine(source);
            }
        }

        Assert.Empty(result.HostDiagnostics);

        var files = new List<GeneratedFile>();
        foreach ((string hintName, string source) in result.GeneratedGsFiles)
        {
            this.output.WriteLine("// " + hintName);
            this.output.WriteLine(source);
            files.Add(new GeneratedFile(hintName, source));
        }

        // Compile the user files with every .g.gs: the pairing must hold and
        // nothing else may fail.
        List<GsSyntaxTree> trees = ParseUser(userSources);
        trees.AddRange(files.Select(file => GsSyntaxTree.Parse(SourceText.From(file.Source, file.HintName + ".gs"))));
        var combined = new Compilation(trees.ToArray())
        {
            IsLibrary = true,
        };
        List<string> errors = Errors(combined);
        foreach (string error in errors)
        {
            this.output.WriteLine(error);
        }

        Assert.Empty(errors);

        using var peStream = new MemoryStream();
        var emit = combined.Emit(peStream);
        foreach (var diagnostic in emit.Diagnostics.Where(diagnostic => diagnostic.IsError))
        {
            this.output.WriteLine("emit: " + diagnostic.Id + " " + diagnostic.Message);
        }

        Assert.True(emit.Success);
        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext("GeneratedPart-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        return new Run(files, loadContext.LoadFromStream(peStream));
    }

    private sealed class GeneratedFile
    {
        public GeneratedFile(string hintName, string source)
        {
            HintName = hintName;
            Source = source;
        }

        public string HintName { get; }

        public string Source { get; }
    }

    private sealed class Run
    {
        public Run(List<GeneratedFile> files, Assembly assembly)
        {
            Files = files;
            Assembly = assembly;
        }

        public List<GeneratedFile> Files { get; }

        public Assembly Assembly { get; }

        public string File(string hintName) => Files.Single(file => file.HintName == hintName).Source;

        public Type Type(string name) => Assembly.GetTypes().Single(type => type.Name == name);
    }

    /// <summary>A generator that adds the same fixed documents to every compilation.</summary>
    private sealed class FixedSourceGenerator : IIncrementalGenerator
    {
        private readonly (string HintName, string Source)[] documents;

        public FixedSourceGenerator(params (string HintName, string Source)[] documents)
        {
            this.documents = documents;
        }

        public void Initialize(IncrementalGeneratorInitializationContext context)
        {
            context.RegisterPostInitializationOutput(production =>
            {
                foreach ((string hintName, string source) in this.documents)
                {
                    production.AddSource(hintName, source);
                }
            });
        }
    }

    /// <summary>
    /// A generator that implements every lone partial method definition
    /// returning <c>int</c> in the style of <c>@LoggerMessage</c>: spelling the
    /// signature from the symbol (so C# <c>int</c>, back-translated as
    /// <c>int32</c>), with a body that doubles the first parameter or
    /// subtracts the second from the first.
    /// </summary>
    private sealed class PartialImplementationGenerator : IIncrementalGenerator
    {
        private readonly bool renameParameters;

        public PartialImplementationGenerator(bool renameParameters)
        {
            this.renameParameters = renameParameters;
        }

        public void Initialize(IncrementalGeneratorInitializationContext context)
        {
            var methods = context.SyntaxProvider.CreateSyntaxProvider(
                static (node, _) => node is MethodDeclarationSyntax method
                    && method.Body == null
                    && method.ExpressionBody == null
                    && method.Modifiers.Any(modifier => modifier.ValueText == "partial"),
                static (syntaxContext, _) => (IMethodSymbol)syntaxContext.SemanticModel.GetDeclaredSymbol(syntaxContext.Node));
            context.RegisterSourceOutput(methods.Collect(), (production, symbols) =>
            {
                var builder = new StringBuilder();
                foreach (IMethodSymbol method in symbols)
                {
                    if (method.ReturnType.SpecialType != SpecialType.System_Int32)
                    {
                        continue;
                    }

                    List<string> names = method.Parameters
                        .Select(parameter => this.renameParameters ? parameter.Name + "Renamed" : parameter.Name)
                        .ToList();

                    // A string parameter is restated with the default "a b"
                    // (single space), whatever the definition says.
                    string parameters = string.Join(", ", method.Parameters.Select((parameter, i) =>
                        parameter.Type.SpecialType switch
                        {
                            SpecialType.System_String => "string " + names[i] + " = \"a b\"",
                            SpecialType.System_Int32 => "int " + names[i],
                            _ => parameter.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) + " " + names[i],
                        }));
                    string body = method.Parameters.Any(parameter => parameter.Type.SpecialType != SpecialType.System_Int32)
                        ? "42"
                        : names.Count == 1 ? names[0] + " * 2" : names[0] + " - " + names[1];
                    string typeParameters = method.ContainingType.TypeParameters.Length == 0
                        ? string.Empty
                        : "<" + string.Join(", ", method.ContainingType.TypeParameters.Select(parameter => parameter.Name)) + ">";
                    builder.Append("namespace ").Append(method.ContainingNamespace.ToDisplayString()).AppendLine(" {")
                        .Append("partial class ").Append(method.ContainingType.Name).Append(typeParameters).AppendLine(" {")
                        .Append("    public static partial int ").Append(method.Name)
                        .Append('(').Append(parameters).Append(") => ").Append(body).AppendLine(";")
                        .AppendLine("}")
                        .AppendLine("}");
                }

                production.AddSource("Implementations.g.cs", builder.ToString());
            });
        }
    }
}
