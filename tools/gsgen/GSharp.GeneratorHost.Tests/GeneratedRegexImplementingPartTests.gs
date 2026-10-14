// <copyright file="GeneratedRegexImplementingPartTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Text
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import Xunit
import Xunit.Abstractions
import GSharp.GeneratorHost.Tests.StubTestSupport
import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis
import GSharp.GeneratorHost
import System.Collections.Immutable
import System.Threading

/// ADR-0192 follow-on 2, steps 3 and 4: a G# `@GeneratedRegex` declaring
/// part drives the REAL Regex generator through the stub, and the
/// back-translated `.g.gs` carries the generated implementation as a G#
/// IMPLEMENTING part (`partial func` with its body) that pairs with it.
/// Step 4: the generator's helper types keep their own package (no collision
/// with user types), and the implementing part is spelled with the user's own
/// header so a differently spelled declaring part still pairs.
open partial class GeneratedRegexImplementingPartTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    // The patterns span the generator's shapes: a simple loop, captures with
    // options, and a backtracking alternation whose C# passes
    // `ref base.runstack!` (a by-ref argument under `!`).
    @Theory
    @InlineData("\"\\\\d+\"", "a1")
    @InlineData("\"^(?<y>\\\\d{4})-(?<m>\\\\d{2})$$\", RegexOptions.IgnoreCase", "2024-05")
    @InlineData("\"(foo|ba+r)+\\\\w*?baz\", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase", "xxFOObaarQQbaz")
    func RealRegexGenerator_BackTranslatesToAnImplementingPart_ThatCompilesAndRuns(arguments string, match string) {
        let userSource = UserSourceTemplate.Replace("ARGUMENTS", arguments, StringComparison.Ordinal)
        let run = this.GenerateAndCompile([]string{userSource}, RegexGenerator())
        let userPart = run.File("RegexGenerator.g.cs")
        Assert.Contains("package App", userPart, StringComparison.Ordinal)
        Assert.Contains("private partial func Digits() Regex -> Digits_0.Instance", userPart, StringComparison.Ordinal)
        Assert.Contains("import " + GeneratedPackage, userPart, StringComparison.Ordinal)
        let p = run.Type("P")
        Assert.Equal(true, Invoke(p, "Test", match))
        Assert.Equal(false, Invoke(p, "Test", "zzz"))
        Assert.StartsWith(GeneratedPackage + ".", cast[string](Invoke(p, "Kind")), StringComparison.Ordinal)
    }

    // ADR-0195 / issue #4674: a `shared partial class` is a C# static class, so the stub
    // renders it as one and the generated implementing part is back-translated as a
    // `shared partial class` part with its members flat, which merges with the user's
    // (GS0479 otherwise: every part of a shared class must say `shared`).
    @Fact
    func SharedPartialClass_GeneratedImplementingPart_IsAlsoShared_AndCompilesAndRuns() {
        const userSource = `package App

import System.Text.RegularExpressions

shared partial class P {
    @GeneratedRegex("\\d+")
    private partial func Digits() Regex;

    public func Test(s string) bool {
        return Digits().IsMatch(s)
    }
}
`
        let run = this.GenerateAndCompile([]string{userSource}, RegexGenerator())
        let userPart = run.File("RegexGenerator.g.cs")
        Assert.Contains("shared partial class P", userPart, StringComparison.Ordinal)
        Assert.Contains("private partial func Digits() Regex -> Digits_0.Instance", userPart, StringComparison.Ordinal)
        Assert.DoesNotContain("shared {", userPart, StringComparison.Ordinal)
        let p = run.Type("P")
        Assert.True(p.IsAbstract && p.IsSealed, "a shared partial class is CLR abstract sealed")
        Assert.Equal(true, Invoke(p, "Test", "a1"))
        Assert.Equal(false, Invoke(p, "Test", "zzz"))
    }

    // Step 4: the generator's `file` helper types (`Digits_0`, `Utilities`,
    // `RunnerFactory`, the `IndexOfAny*` extension funcs) come out in their
    // own package, so a user type named `Utilities` no longer collides with
    // them (it was GS0102, with the helpers' members then unresolvable).
    @Fact
    func GeneratedHelpers_KeepTheirOwnPackage_SoAUserUtilitiesTypeDoesNotCollide() {
        let userSource = UserSourceTemplate.Replace("ARGUMENTS", "\"\\\\d+\"", StringComparison.Ordinal) + `
class Utilities {
    public func Name() string {
        return "user utilities"
    }
}
`
        let run = this.GenerateAndCompile([]string{userSource}, RegexGenerator())
        let userPart = run.File("RegexGenerator.g.cs")
        let helpers = run.File("RegexGenerator.System_Text_RegularExpressions_Generated.g.cs")
        Assert.DoesNotContain("class Utilities", userPart, StringComparison.Ordinal)
        // Issue #4653: the generator's `// <auto-generated/>` header is kept.
        Assert.StartsWith(`// <auto-generated/>

package ` + GeneratedPackage, helpers, StringComparison.Ordinal)
        Assert.Contains("internal class Digits_0", helpers, StringComparison.Ordinal)
        Assert.Contains("class Utilities", helpers, StringComparison.Ordinal)
        Assert.DoesNotContain("import " + GeneratedPackage, helpers, StringComparison.Ordinal)
        let p = run.Type("P")
        Assert.Equal(true, Invoke(p, "Test", "a1"))
        Assert.Equal(GeneratedPackage + ".Digits_0", Invoke(p, "Kind"))
    }

    @Fact
    func GeneratedHelperReference_BindsWhenUserImportDeclaresTheSameSimpleName() {
        let userSource = UserSourceTemplate.Replace("ARGUMENTS", "\"\\\\d+\"", StringComparison.Ordinal)
        const CollisionSource = `package System.Text.RegularExpressions

class Digits_0 {
}`
        let run = this.GenerateAndCompile([]string{userSource, CollisionSource}, RegexGenerator())
        let p = run.Type("P")
        Assert.Equal(true, Invoke(p, "Test", "a1"))
        Assert.Equal(GeneratedPackage + ".Digits_0", Invoke(p, "Kind"))
    }

    // Two user packages that each use the generator: the generator emits ONE
    // file with one `Generated` namespace, so there is exactly one set of
    // helper types, shared by both packages' implementing parts.
    @Fact
    func TwoUserPackages_ShareOneHelperPackage() {
        let app = UserSourceTemplate.Replace("ARGUMENTS", "\"\\\\d+\"", StringComparison.Ordinal)
        const Lib = `package Lib

import System.Text.RegularExpressions

partial class Q {
    shared {
        @GeneratedRegex("^[a-z]+$", RegexOptions.IgnoreCase)
        internal partial func Word() Regex;

        public func Test(s string) bool {
            return Word().IsMatch(s)
        }
    }
}
`
        let run = this.GenerateAndCompile([]string{app, Lib}, RegexGenerator())
        Assert.Equal(3, run.Files.Count)
        Assert.Contains("package Lib", run.File("RegexGenerator.Lib.g.cs"), StringComparison.Ordinal)
        let utilities = run.Files.Sum((file GeneratedFile) -> CountOccurrences(file.Source, "class Utilities"))
        Assert.Equal(1, utilities)
        Assert.Equal(true, Invoke(run.Type("P"), "Test", "a1"))
        Assert.Equal(true, Invoke(run.Type("Q"), "Test", "HeLLo"))
        Assert.Equal(false, Invoke(run.Type("Q"), "Test", "he llo"))
    }

    // Step 4: pairing is textual (GS0611), so the implementing part is spelled
    // with the declaring part's own header — here a fully qualified return
    // type the back-translation would have shortened to `Regex`.
    @Fact
    func DifferentlySpelledHeader_IsCopiedIntoTheImplementingPart() {
        let userSource = UserSourceTemplate.Replace("ARGUMENTS", "\"\\\\d+\"", StringComparison.Ordinal).Replace(
            "private partial func Digits() Regex;",
            "private partial func Digits() System.Text.RegularExpressions.Regex;",
            StringComparison.Ordinal
        )
        let run = this.GenerateAndCompile([]string{userSource}, RegexGenerator())
        Assert.Contains(
            "private partial func Digits() System.Text.RegularExpressions.Regex -> Digits_0.Instance",
            run.File("RegexGenerator.g.cs"),
            StringComparison.Ordinal
        )
        Assert.Equal(true, Invoke(run.Type("P"), "Test", "a1"))
    }

    // A declaring part spelled with an alias the user's file imports: the
    // alias import is brought into the .g.gs so the copied header binds.
    @Fact
    func AliasSpelledHeader_BringsTheAliasImport() {
        const UserSource = `package App

import System.Text.RegularExpressions
import Rx = System.Text.RegularExpressions.Regex

partial class P {
    shared {
        @GeneratedRegex("\\d+")
        private partial func Digits() Rx;

        public func Test(s string) bool {
            return Digits().IsMatch(s)
        }
    }
}
`
        let run = this.GenerateAndCompile([]string{UserSource}, RegexGenerator())
        let userPart = run.File("RegexGenerator.g.cs")
        Assert.Contains("import Rx = System.Text.RegularExpressions.Regex", userPart, StringComparison.Ordinal)
        Assert.Contains("private partial func Digits() Rx -> Digits_0.Instance", userPart, StringComparison.Ordinal)
        Assert.Equal(true, Invoke(run.Type("P"), "Test", "a1"))
    }

    // A parameter type spelled `int` where the back-translated C# `int` would
    // be `int32` (the `@LoggerMessage` shape): GS0264/GS0610/GS0609 before.
    @Fact
    func ParameterTypeAliasSpelling_IsCopiedIntoTheImplementingPart() {
        const UserSource = `package App

partial class Calc {
    shared {
        public partial func Twice(count int) int;
    }
}
`
        let run = this.GenerateAndCompile([]string{UserSource}, PartialImplementationGenerator(renameParameters: false))
        Assert.Contains("public partial func Twice(count int) int", run.Files.Single().Source, StringComparison.Ordinal)
        Assert.Equal(42, Invoke(run.Type("Calc"), "Twice", 21))
    }

    // Copilot review (#4430): the owning type's generic arity is part of the
    // match. `P` and `P[T]` both declare `Twice` with one parameter; matched on
    // name alone, each implementation fits both declaring parts, nothing is
    // copied, and the `int` headers fail to pair with the generated `int32`.
    @Fact
    func SameNamedTypesOfDifferentArity_EachGetTheirOwnHeader() {
        const UserSource = `package App

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
`
        let run = this.GenerateAndCompile([]string{UserSource}, PartialImplementationGenerator(renameParameters: false))
        Assert.Equal(2, CountOccurrences(run.Files.Single().Source, "public partial func Twice(count int) int"))
        Assert.Equal(42, Invoke(run.Assembly.GetTypes().Single((type Type) -> type.Name == "Calc"), "Twice", 21))
    }

    // Copilot review (#4430): headers are compared token by token, the way
    // gsc's pairing check compares them, so whitespace inside a literal
    // counts. The generated default "a b" and the declared "a  b" differ, so
    // the declared header is copied; a character-level whitespace collapse
    // treated them as equal, skipped the copy, and gsc reported GS0611.
    @Fact
    func LiteralWhitespace_InADefaultValue_IsNotNormalizedAway() {
        const UserSource = `package App

partial class Calc {
    shared {
        partial func Greet(name string = "a  b") int32;
    }
}
`
        let run = this.GenerateAndCompile([]string{UserSource}, PartialImplementationGenerator(renameParameters: false))
        Assert.Contains(
            "partial func Greet(name string = \"a  b\") int32",
            run.Files.Single().Source,
            StringComparison.Ordinal
        )
    }

    // Copilot review (#4430): an alias import copied for the header keeps its
    // G# spelling. The target's `$class` segment is a keyword escape; spelled
    // by value it printed `import K = class.Mark`, which does not parse.
    // The alias names a parameter annotation, which the generated
    // implementation does not restate, so the header must be copied.
    @Fact
    func CopiedAliasImport_KeepsKeywordEscapes() {
        const KeywordPackage = `package $class

class Mark : System.Attribute {
}
`
        const UserSource = `package App

import K = $class.Mark

partial class Calc {
    shared {
        public partial func Twice(@K count int32) int32;
    }
}
`
        let run = this.GenerateAndCompile(
            []string{KeywordPackage, UserSource},
            PartialImplementationGenerator(renameParameters: false)
        )
        let generated = run.Files.Single().Source
        Assert.Contains("import K = $$class.Mark", generated, StringComparison.Ordinal)
        Assert.Contains("public partial func Twice(@K count int32) int32", generated, StringComparison.Ordinal)
        Assert.Equal(42, Invoke(run.Type("Calc"), "Twice", 21))
    }

    // Copilot review (#4430): only a bare name or the LEFTMOST segment of a
    // qualified name can resolve through an alias. `Regex` here is the last
    // segment of `System.Text.RegularExpressions.Regex`, so the unused alias
    // `Regex` must not be copied into the .g.gs.
    @Fact
    func AliasNamedLikeATrailingSegment_IsNotCopied() {
        const UserSource = `package App

import System.Text.RegularExpressions
import Regex = System.Text.StringBuilder

partial class P {
    shared {
        @GeneratedRegex("\\d+")
        private partial func Digits() System.Text.RegularExpressions.Regex;

        public func Test(s string) bool {
            return Digits().IsMatch(s)
        }
    }
}
`
        let run = this.GenerateAndCompile([]string{UserSource}, RegexGenerator())
        let userPart = run.File("RegexGenerator.g.cs")
        Assert.Contains(
            "private partial func Digits() System.Text.RegularExpressions.Regex ->",
            userPart,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("import Regex =", userPart, StringComparison.Ordinal)
        Assert.Equal(true, Invoke(run.Type("P"), "Test", "a1"))
    }

    // The leading segment of a qualified name is what an alias resolves:
    // `R.Regex` needs `import R = System.Text.RegularExpressions`.
    @Fact
    func AliasAsTheLeadingSegment_IsCopied() {
        const UserSource = `package App

import System.Text.RegularExpressions
import R = System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex("\\d+")
        private partial func Digits() R.Regex;

        public func Test(s string) bool {
            return Digits().IsMatch(s)
        }
    }
}
`
        let run = this.GenerateAndCompile([]string{UserSource}, RegexGenerator())
        let userPart = run.File("RegexGenerator.g.cs")
        Assert.Contains("import R = System.Text.RegularExpressions", userPart, StringComparison.Ordinal)
        Assert.Contains("private partial func Digits() R.Regex ->", userPart, StringComparison.Ordinal)
        Assert.Equal(true, Invoke(run.Type("P"), "Test", "a1"))
    }

    // Copilot review (#4430): only the names a header REFERENCES can need an
    // alias. Two files of one partial class carry unused aliases named like
    // their parameter (`count`) that disagree; neither header uses them, so
    // both headers are copied and nothing is reported.
    @Fact
    func UnusedAliasNamedLikeAParameter_IsNotRequired() {
        const First = `package App

import count = System.Text

partial class Calc {
    shared {
        public partial func Twice(count int) int;
    }
}
`
        const Second = `package App

import count = System.IO

partial class Calc {
    shared {
        public partial func Thrice(count int) int;
    }
}
`
        let run = this.GenerateAndCompile(
            []string{First, Second},
            PartialImplementationGenerator(renameParameters: false)
        )
        let generated = run.Files.Single().Source
        Assert.Contains("public partial func Twice(count int) int", generated, StringComparison.Ordinal)
        Assert.Contains("public partial func Thrice(count int) int", generated, StringComparison.Ordinal)
        Assert.DoesNotContain("import count", generated, StringComparison.Ordinal)
    }

    // A generated implementation whose parameter names differ from the
    // declaring part's must not pair silently: copying the header would rebind
    // the body to the wrong names, so the header is left as generated, gsgen
    // reports GS9208 at the declaring part, and gsc reports GS0611.
    @Fact
    func ParameterNameMismatch_IsReported_NotCopied() {
        const UserSource = `package App

partial class Calc {
    shared {
        public partial func Sub(a int32, b int32) int32;
    }
}
`
        let user = Compilation(GsSyntaxTree.Parse(SourceText.From(UserSource, "User.gs")))
        let result = GeneratorHostRunner.Run(
            user,
            CSharpProjectLoader.RuntimeReferences(),
            []IIncrementalGenerator{PartialImplementationGenerator(renameParameters: true)}
        )
        let diagnostic = Assert.Single(result.HostDiagnostics)
        this.output.WriteLine(diagnostic.Message)
        Assert.Equal("GS9208", diagnostic.Id)
        Assert.Equal("User.gs", diagnostic.Location.FileName)
        Assert.Contains("'aRenamed'", diagnostic.Message, StringComparison.Ordinal)
        let (hintName, generated) = Assert.Single(result.GeneratedGsFiles)
        let combined = Compilation(
            GsSyntaxTree.Parse(SourceText.From(UserSource, "User.gs")),
            GsSyntaxTree.Parse(SourceText.From(generated, hintName + ".gs"))
        ){IsLibrary = true}
        Assert.Contains(Errors(combined), (error string) -> error.StartsWith("GS0611", StringComparison.Ordinal))
    }

    // A partial class split across two files that alias `R` differently: each
    // header binds in its own file, but both are copied into one .g.gs with
    // one import scope. The second header is left as generated, and GS9208
    // names both user files rather than blaming the generated code.
    @Fact
    func AliasClashBetweenTwoUserFiles_IsReportedAgainstBothFiles() {
        const First = `package App

import System.Text.RegularExpressions
import R = System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex("\\d+")
        private partial func Digits() R.Regex;
    }
}
`
        const Second = `package App

import System.Text.RegularExpressions
import R = System.Text

partial class P {
    shared {
        @GeneratedRegex("[a-z]+")
        private partial func Word() R.RegularExpressions.Regex;
    }
}
`
        let user = Compilation(ParseUser([]string{First, Second}).ToArray())
        let result = GeneratorHostRunner.RunFromAnalyzerPaths(
            user,
            CSharpProjectLoader.RuntimeReferences(),
            []string{RegexGenerator()!!}
        )
        Assert.Empty(result.GeneratorDiagnostics)
        let diagnostic = Assert.Single(result.HostDiagnostics)
        this.output.WriteLine(diagnostic.Message)
        Assert.Equal("GS9208", diagnostic.Id)
        Assert.Equal("User1.gs", diagnostic.Location.FileName)
        Assert.Contains("'import R = System.Text' from 'User1.gs'", diagnostic.Message, StringComparison.Ordinal)
        Assert.Contains(
            "from 'User0.gs', needs it as 'System.Text.RegularExpressions'",
            diagnostic.Message,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("the generated code", diagnostic.Message, StringComparison.Ordinal)
    }

    // PR #4430 review: a header that is not copied (its alias `R` clashes)
    // must not leave its other alias (`Q`) committed, or a later valid header
    // needing a different `Q` gets a spurious GS9208 and loses its copy.
    @Fact
    func RejectedHeader_LeavesNoStaleAliasForALaterHeader() {
        const First = `package App

import R = System.Text.RegularExpressions

partial class P {
    shared {
        private partial func A() R.Regex;
    }
}
`
        const Second = `package App

import Q = System.Text
import R = System.Text

partial class P {
    shared {
        private partial func B(q Q.StringBuilder) R.RegularExpressions.Regex;
    }
}
`
        const Third = `package App

import Q = System.Text.RegularExpressions

partial class P {
    shared {
        private partial func C() Q.Regex;
    }
}
`
        const Generated = `namespace App
{
    partial class P
    {
        private static partial System.Text.RegularExpressions.Regex A() => default;
        private static partial System.Text.RegularExpressions.Regex B(System.Text.StringBuilder q) => default;
        private static partial System.Text.RegularExpressions.Regex C() => default;
    }
}
`
        let result = GeneratorHostRunner.Run(
            Compilation(ParseUser([]string{First, Second, Third}).ToArray()),
            CSharpProjectLoader.RuntimeReferences(),
            []IIncrementalGenerator{FixedSourceGenerator(("Impl.g.cs", Generated))}
        )
        for reported in result.HostDiagnostics {
            this.output.WriteLine("${reported.Location.FileName}: ${reported.Message}")
        }
        let diagnostic = Assert.Single(result.HostDiagnostics)
        Assert.Equal("GS9208", diagnostic.Id)
        Assert.Equal("User1.gs", diagnostic.Location.FileName)
    }

    // ADR-0192 follow-on 2 review: a generated document with two or more
    // named namespaces is split into one unit per namespace, and its
    // global-namespace declarations must land in one of them (the first, as
    // the unsplit translation hoisted them into a package) instead of matching
    // no unit's filter and vanishing. User code still reaches them.
    @Fact
    func GlobalDeclarations_OfASplitDocument_StayReachable() {
        const UserSource = `package App

import System

class Probe {
    shared {
        public func Value() int32 {
            return GlobalHelper.G + Gen.Utilities.U
        }
    }
}
`
        const Generated = `namespace Gen.Helpers.Deep { internal static class DeepHelper { public static int D => 3; } }
namespace Gen { internal static class Utilities { public static int U => 2; } }
internal static class GlobalHelper { public static int G => 7; }
`
        let run = this.GenerateAndCompile([]string{UserSource}, FixedSourceGenerator(("Impl.g.cs", Generated)))
        Assert.Equal(2, run.Files.Count)
        let primary = run.File("Impl.g.cs")
        Assert.StartsWith(
            "package Gen\n",
            primary.Replace("\r\n", "\n", StringComparison.Ordinal),
            StringComparison.Ordinal
        )
        Assert.Contains("class GlobalHelper", primary, StringComparison.Ordinal)
        Assert.Equal(1, run.Files.Sum((file GeneratedFile) -> CountOccurrences(file.Source, "class GlobalHelper")))
        Assert.Equal(9, Invoke(run.Type("Probe"), "Value"))
    }

    // A split unit's file name never takes one a generator hint name owns:
    // `Mixed.cs`'s `Lib.B` unit would be `Mixed.Lib_B`, which the real
    // `Mixed.Lib_B.cs` owns, so the split unit gets a `.split` marker and the
    // result does not depend on write order.
    @Fact
    func SplitUnitName_NeverTakesAGeneratorHintName() {
        const Mixed = `namespace Lib.A { internal static class First { public static int V => 1; } }
namespace Lib.B { internal static class Second { public static int V => 2; } }
`
        const Real = "namespace Other { internal static class Third { public static int V => 3; } }\n"
        let user = Compilation(GsSyntaxTree.Parse(SourceText.From("package App\n", "User0.gs")))
        let result = GeneratorHostRunner.Run(
            user,
            CSharpProjectLoader.RuntimeReferences(),
            []IIncrementalGenerator{FixedSourceGenerator(("Mixed.cs", Mixed), ("Mixed.Lib_B.cs", Real))}
        )
        Assert.Equal(
            []string{"Mixed.Lib_B.cs", "Mixed.Lib_B.split.g.cs", "Mixed.cs"},
            result
                .GeneratedGsFiles
                .Select((file(HintName string, GSharpSource string)) -> file.HintName)
                .OrderBy((name string) -> name, StringComparer.Ordinal)
                .ToArray()
        )
        Assert.Contains(
            "package Other",
            result
                .GeneratedGsFiles
                .Single((file(HintName string, GSharpSource string)) -> file.HintName == "Mixed.Lib_B.cs")
                .GSharpSource,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "package Lib.B",
            result
                .GeneratedGsFiles
                .Single((file(HintName string, GSharpSource string)) -> file.HintName == "Mixed.Lib_B.split.g.cs")
                .GSharpSource,
            StringComparison.Ordinal
        )
    }

    // ADR-0192 amendment (partial data types): the declaring part lives in a
    // `partial data class` / `partial data struct` — the G# spelling of the C#
    // `partial record` / `partial record struct` that code-exploder's
    // `GitHubUrl` is. The stub must offer the owner to the generator as a C#
    // record, and the back-translated implementing part must be a `data` part,
    // or gsc rejects the pair (GS0479: `data` must appear on every part).
    @Theory
    @InlineData("public sealed partial data class")
    @InlineData("public partial data struct")
    func DeclaringPartInAPartialDataType_IsImplementedByTheRealGenerator(header string) {
        let userSource = `package App

import System
import System.Text.RegularExpressions

HEADER GitHubUrl(Owner string, Name string, PrNumber int32?) {
    shared {
        @GeneratedRegex("^https://github\\.com/(?<owner>[^/]+)/(?<name>[^/]+)(/pull/(?<pr>\\d+))?$", RegexOptions.ExplicitCapture, 1000)
        private partial func Pattern() Regex;

        public func OwnerOf(url string) string {
            let m = Pattern().Match(url.Trim())
            return m.Success ? m.Groups["owner"].Value : ""
        }

        public func Captures(url string) int32 {
            return Pattern().Match(url).Groups.Count
        }

        public func Options() string {
            return Pattern().Options.ToString()
        }

        public func TimeoutMs() float64 {
            return Pattern().MatchTimeout.TotalMilliseconds
        }

        public func Show() string {
            let a = GitHubUrl("o", "n", 7)
            let b = a with { Name = "m" }
            return a.ToString() + "|" + (a == GitHubUrl("o", "n", 7)).ToString() + "|" + b.Name
        }
    }
}
`.Replace("HEADER", header, StringComparison.Ordinal)
        let run = this.GenerateAndCompile([]string{userSource}, RegexGenerator())
        let userPart = run.File("RegexGenerator.g.cs")
        Assert.Contains(
            header.Replace("public ", string.Empty, StringComparison.Ordinal).Replace(
                "sealed ",
                string.Empty,
                StringComparison.Ordinal
            ) +
                " GitHubUrl",
            userPart,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "private partial func Pattern() Regex -> Pattern_0.Instance",
            userPart,
            StringComparison.Ordinal
        )
        let type = run.Type("GitHubUrl")
        Assert.Equal("DavidObando", Invoke(type, "OwnerOf", "  https://github.com/DavidObando/gsharp/pull/12 "))
        Assert.Equal(string.Empty, Invoke(type, "OwnerOf", "https://example.com/a/b"))
        // ExplicitCapture: only group 0 and the three named groups exist.
        Assert.Equal(4, Invoke(type, "Captures", "https://github.com/a/b"))
        Assert.Equal("ExplicitCapture", Invoke(type, "Options"))
        Assert.Equal(1000.0, Invoke(type, "TimeoutMs"))
        Assert.Equal("GitHubUrl { Owner = o, Name = n, PrNumber = 7 }|True|m", Invoke(type, "Show"))
    }

    // A data class with a base class cannot be a C# record in the stub (a
    // record derives only from a record, CS8864), so the generator re-declares
    // it as a `partial class`; the back-translated part must still be a `data`
    // part (GS0479 otherwise).
    @Fact
    func DeclaringPartInADataClassWithABaseClass_IsImplementedAsADataPart() {
        const UserSource = `package App

import System.Text.RegularExpressions

open class Entity {
}

partial data class Tag(Name string) : Entity {
    shared {
        @GeneratedRegex("^[a-z]+$")
        private partial func Word() Regex;

        public func Test(s string) bool {
            return Word().IsMatch(s)
        }
    }
}
`
        let run = this.GenerateAndCompile([]string{UserSource}, RegexGenerator())
        let userPart = run.File("RegexGenerator.g.cs")
        Assert.Contains("partial data class Tag : Entity {", userPart, StringComparison.Ordinal)
        Assert.Equal(true, Invoke(run.Type("Tag"), "Test", "abc"))
        Assert.Equal(false, Invoke(run.Type("Tag"), "Test", "ab1"))
    }

    // A positional parameter list a generator supplies on a user data type
    // with none is kept, not dropped, so the generated part still supplies
    // the primary constructor and its properties.
    @Fact
    func GeneratorSuppliedPositionalList_IsKept_WhenTheUserDataTypeHasNone() {
        const UserSource = `package App

partial data class Point {
    shared {
        public func Sum() int32 {
            let p = Point(3, 4)
            return p.X + p.Y
        }
    }
}
`
        const Generated = `namespace App
{
    partial record Point(int X, int Y);
}
`
        let run = this.GenerateAndCompile([]string{UserSource}, FixedSourceGenerator(("Point.g.cs", Generated)))
        Assert.Contains("partial data class Point(X int32, Y int32)", run.File("Point.g.cs"), StringComparison.Ordinal)
        Assert.Equal(7, Invoke(run.Type("Point"), "Sum"))
    }

    // Only one part may state the positional list (GS0482). When the user's
    // data type already has one, a generated one is reported as GS9209 at the
    // user's list rather than silently dropped.
    @Fact
    func GeneratorSuppliedPositionalList_OnAUserDataTypeWithOne_ReportsGS9209() {
        const UserSource = `package App

partial data class Point(X int32) {
}
`
        const Generated = `namespace App
{
    partial record Point(int X);
}
`
        let result = GeneratorHostRunner.Run(
            Compilation(ParseUser([]string{UserSource}).ToArray()),
            CSharpProjectLoader.RuntimeReferences(),
            []IIncrementalGenerator{FixedSourceGenerator(("Point.g.cs", Generated))}
        )
        let diagnostic = Assert.Single(result.HostDiagnostics)
        Assert.Equal("GS9209", diagnostic.Id)
        Assert.Equal("User0.gs", diagnostic.Location.FileName)
        Assert.Equal(2, diagnostic.Location.StartLine)
        Assert.Contains(
            "partial data class Point(X int32)",
            result.GeneratedGsFiles.Single().GSharpSource,
            StringComparison.Ordinal
        )
    }

    private func GenerateAndCompile(userSources IReadOnlyList[string], analyzerPath string?) Run {
        let result = GeneratorHostRunner.RunFromAnalyzerPaths(
            Compilation(ParseUser(userSources).ToArray()),
            CSharpProjectLoader.RuntimeReferences(),
            []string{analyzerPath!!}
        )
        return this.Compile(userSources, result)
    }

    private func GenerateAndCompile(userSources IReadOnlyList[string], generator IIncrementalGenerator) Run {
        let result = GeneratorHostRunner.Run(
            Compilation(ParseUser(userSources).ToArray()),
            CSharpProjectLoader.RuntimeReferences(),
            []IIncrementalGenerator{generator}
        )
        return this.Compile(userSources, result)
    }

    private func Compile(userSources IReadOnlyList[string], result GeneratorHostResult) Run {
        Assert.Empty(result.Failures)
        Assert.Empty(result.GeneratorDiagnostics)
        for diagnostic in result.HostDiagnostics {
            this.output.WriteLine(diagnostic.Id + ": " + diagnostic.Message)
        }
        if result.HostDiagnostics.Count > 0 {
            for (hintName, source) in result.GeneratedGsFiles {
                this.output.WriteLine("// " + hintName)
                this.output.WriteLine(source)
            }
        }
        Assert.Empty(result.HostDiagnostics)
        let files = List[GeneratedFile]()
        for (hintName, source) in result.GeneratedGsFiles {
            this.output.WriteLine("// " + hintName)
            this.output.WriteLine(source)
            files.Add(GeneratedFile(hintName, source))
        }
        // Compile the user files with every .g.gs: the pairing must hold and
        // nothing else may fail.
        let trees = ParseUser(userSources)
        trees.AddRange(
            files.Select(
                (file GeneratedFile) -> GsSyntaxTree.Parse(SourceText.From(file.Source, file.HintName + ".gs"))
            )
        )
        let combined = Compilation(trees.ToArray()){IsLibrary = true}
        let errors = Errors(combined)
        for error in errors {
            this.output.WriteLine(error)
        }
        Assert.Empty(errors)
        using let peStream = MemoryStream()
        let emit = combined.Emit(peStream)
        for diagnostic in emit.Diagnostics.Where(
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        ) {
            this.output.WriteLine("emit: " + diagnostic.Id + " " + diagnostic.Message)
        }
        Assert.True(emit.Success)
        peStream.Position = 0
        let loadContext = AssemblyLoadContext("GeneratedPart-" + Guid.NewGuid().ToString("N"), isCollectible: true)
        return Run(files, loadContext.LoadFromStream(peStream))
    }

    private class GeneratedFile {
        init(hintName string, source string) {
            HintName = hintName
            Source = source
        }

        prop HintName string {
            get;
        }

        prop Source string {
            get;
        }
    }

    private class Run {
        init(files List[GeneratedFile], assembly Assembly) {
            Files = files
            Assembly = assembly
        }

        prop Files List[GeneratedFile] {
            get;
        }

        prop Assembly Assembly {
            get;
        }

        func File(hintName string) string -> Files.Single((file GeneratedFile) -> file.HintName == hintName).Source

        func Type(name string) Type -> Assembly.GetTypes().Single((type Type) -> type.Name == name)
    }

    /// A generator that adds the same fixed documents to every compilation.
    private class FixedSourceGenerator : IIncrementalGenerator {
        private let documents[](HintName string, Source string) = System.Array.Empty[(HintName string, Source string)]()

        init(documents ...(HintName string, Source string)) {
            this.documents = documents
        }

        func Initialize(context IncrementalGeneratorInitializationContext) {
            context.RegisterPostInitializationOutput(
                (production IncrementalGeneratorPostInitializationContext) -> {
                    for (hintName, source) in this.documents {
                        production.AddSource(hintName, source)
                    }
                }
            )
        }
    }

    /// A generator that implements every lone partial method definition
    /// returning `int` in the style of `@LoggerMessage`: spelling the
    /// signature from the symbol (so C# `int`, back-translated as
    /// `int32`), with a body that doubles the first parameter or
    /// subtracts the second from the first.
    private class PartialImplementationGenerator : IIncrementalGenerator {
        private let renameParameters bool

        init(renameParameters bool) {
            this.renameParameters = renameParameters
        }

        func Initialize(context IncrementalGeneratorInitializationContext) {
            let methods = context.SyntaxProvider.CreateSyntaxProvider(
                (
                    node Microsoft.CodeAnalysis.SyntaxNode,
                    _ CancellationToken
                ) -> node is MethodDeclarationSyntax method &&
                    method.Body == nil &&
                    method.ExpressionBody == nil &&
                    method
                    .Modifiers
                    .Any((modifier Microsoft.CodeAnalysis.SyntaxToken) -> modifier.ValueText == "partial"),
                (syntaxContext GeneratorSyntaxContext, _ CancellationToken) -> cast[IMethodSymbol](
                    syntaxContext.SemanticModel.GetDeclaredSymbol(syntaxContext.Node)
                )
            )
            context.RegisterSourceOutput(
                methods.Collect(),
                (production SourceProductionContext, symbols ImmutableArray[IMethodSymbol]) -> {
                    let builder = StringBuilder()
                    for method in symbols {
                        if method.ReturnType.SpecialType != SpecialType.System_Int32 {
                            continue
                        }
                        let names = method
                            .Parameters
                            .Select(
                            (parameter IParameterSymbol) -> if this.renameParameters {
                                parameter.Name + "Renamed"
                            } else {
                                parameter.Name
                            }
                        )
                            .ToList()
                        // A string parameter is restated with the default "a b"
                        // (single space), whatever the definition says.
                        let parameters = string.Join(
                            ", ",
                            method.Parameters.Select(
                                (parameter IParameterSymbol, i int32) -> switch parameter.Type.SpecialType {
                                    case SpecialType.System_String: "string " + names[i] + " = \"a b\""
                                    case SpecialType.System_Int32: "int " + names[i]
                                    default: parameter.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) +
                                        " " +
                                        names[i]
                                }
                            )
                        )
                        let body = if method.Parameters.Any(
                            (parameter IParameterSymbol) -> parameter.Type.SpecialType != SpecialType.System_Int32
                        ) {
                            "42"
                        } else {
                            (
                                if names.Count == 1 {
                                    names[0] + " * 2"
                                } else {
                                    names[0] + " - " + names[1]
                                }
                            )
                        }
                        let typeParameters = if method.ContainingType.TypeParameters.Length == 0 {
                            string.Empty
                        } else {
                            "<" + string.Join(
                                ", ",
                                method
                                    .ContainingType
                                    .TypeParameters
                                    .Select((parameter ITypeParameterSymbol) -> parameter.Name)
                            ) +
                                ">"
                        }
                        builder
                            .Append("namespace ")
                            .Append(method.ContainingNamespace.ToDisplayString())
                            .AppendLine(" {")
                            .Append("partial class ")
                            .Append(method.ContainingType.Name)
                            .Append(typeParameters)
                            .AppendLine(" {")
                            .Append("    public static partial int ")
                            .Append(method.Name)
                            .Append('(')
                            .Append(parameters)
                            .Append(") => ")
                            .Append(body)
                            .AppendLine(";")
                            .AppendLine("}")
                            .AppendLine("}")
                    }
                    production.AddSource("Implementations.g.cs", builder.ToString())
                }
            )
        }
    }

    shared {
        private const UserSourceTemplate string = `package App

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
`

        private const GeneratedPackage string = "System.Text.RegularExpressions.Generated"
        private func RegexGenerator() string? -> RegexGeneratorPath()

        private func Invoke(type Type, method string, arguments ...object) object? -> type.GetMethod(
            method,
            BindingFlags.Public | BindingFlags.Static
        )!!.Invoke(nil, arguments)

        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            for var index = text.IndexOf(value, StringComparison.Ordinal); index >= 0; index = text.IndexOf(
                value,
                index + value.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }

        private func Errors(compilation Compilation) List[string] -> compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
            .Select(
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> (
                "${diagnostic.Id} ${diagnostic.Location.Text?.FileName}:${diagnostic.Location.StartLine + 1}: " +
                    diagnostic.Message
            )
        )
            .Distinct(StringComparer.Ordinal)
            .ToList()

        private func ParseUser(userSources IReadOnlyList[string]) List[GsSyntaxTree] -> userSources.Select(
            (source string, index int32) -> GsSyntaxTree.Parse(
                SourceText.From(source, "User" + index.ToString() + ".gs")
            )
        )
            .ToList()
    }
}
