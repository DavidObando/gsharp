// <copyright file="Issue5617ByReferenceAccessorNarrowingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import System.Text
import System.Text.RegularExpressions
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #5617: gsc removes the narrowing fact of a by-reference variable at an accessor that can run user code
/// (ADR-0208 R14, R16 and R17) and at a write through a member or an element (R12). C# flow analysis keeps the
/// fact, so the translated read needs its own `!!`. An accessor that runs no user code keeps the fact, so its read
/// stays bare. Issue #5650: a loop whose iteration can run user code (ADR-0208 R11, ADR-0213) removes the fact
/// too. Each test translates the C#, compiles the G# with the repository's `gsc.dll`, runs it, and compares the
/// output with the output of the C#.
open class Issue5617ByReferenceAccessorNarrowingTests {
    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func RefParameter_CachedBridgeNamesReplayBodyOccupancyBeforeDeconstruction(
        deconstructionFirst bool,
        specialFirst bool
    ) {
        let bridge = "(string, int) typed = pair;"
        let deconstruction = "(tuple, other) = new Numbers();"
        let tree = CSharpSyntaxTree.ParseText(
            "#nullable enable\npublic class Numbers { public void Deconstruct(out int first, out int second) { first = 3; second = 4; } } public static class Demo { public static string Run() { " +
                "(string?, int) pair = (\"x\", 1); int tuple = 0; int other = 0; " +
                (
                if deconstructionFirst {
                    deconstruction + bridge
                } else {
                    bridge + deconstruction
                }
            ) +
                "return typed.Item1 + \":\" + tuple + \":\" + other; } }",
            path: "CachedBridgeBodyOccupancy.cs"
        )
        let compilation = CSharpCompilation.Create(
            "CachedBridgeBodyOccupancy5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let special = compilation.GetSemanticModel(tree, ignoreAccessibility: true)
        var previous string? = nil
        for isSpecial in[]bool{specialFirst, !specialFirst, specialFirst} {
            let context = TranslationContext(
                compilation,
                if isSpecial {
                    special
                } else {
                    normal
                },
                tree.FilePath
            )
            for var pass = 0; pass < 3; pass++ {
                let printed = GSharpPrinter.Print(
                    CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, normal), context)
                )
                Assert.Contains("let tupleValue", printed)
                Assert.Equal(
                    Encoding.UTF8.GetBytes("x:3:4" + Environment.NewLine),
                    Encoding.UTF8.GetBytes(CompileAndRun(printed, Array.Empty[byte](), strictIl: true))
                )
                if previous != nil {
                    Assert.Equal(Encoding.UTF8.GetBytes(previous), Encoding.UTF8.GetBytes(printed))
                }
                previous = printed
            }
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_DeepTupleAllocationPathsReplayAcrossModelPopulations(specialFirst bool) {
        let tree = CSharpSyntaxTree.ParseText(`
#nullable enable
using System;
public static class Demo {
    private static int calls;
    private static (((string?, int)?, int)?, (string?, int)?) Next() {
        calls++;
        return ((("a", 1), 2), ("b", 3));
    }
    private static Func<(((string, int)?, int)?, (string, int)?)> Make(
        (((string?, int)?, int)?, (string?, int)?) value) => () => value;
    public static string Run() {
        calls = 0;
        var value = Make(Next())();
        return value.Item1.Value.Item1.Value.Item1 + value.Item2.Value.Item1 + ":" + calls;
    }
}`, path: "DeepTupleAllocationPaths.cs")
        let compilation = CSharpCompilation.Create(
            "DeepTupleAllocationPaths5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let special = compilation.GetSemanticModel(tree, ignoreAccessibility: true)
        var previous string? = nil
        for isSpecial in[]bool{specialFirst, !specialFirst, specialFirst} {
            let context = TranslationContext(
                compilation,
                if isSpecial {
                    special
                } else {
                    normal
                },
                tree.FilePath
            )
            for var pass = 0; pass < 2; pass++ {
                let printed = GSharpPrinter.Print(
                    CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, normal), context)
                )
                Assert.Equal(
                    Encoding.UTF8.GetBytes("ab:1" + Environment.NewLine),
                    Encoding.UTF8.GetBytes(CompileAndRun(printed, Array.Empty[byte](), strictIl: true))
                )
                let names = Regex
                    .Matches(printed, "let (tupleValue(?:_[0-9]+)?)\\s*=")
                    .Cast[Match]()
                    .Select((match Match) -> match.Groups[1].Value)
                    .ToArray()
                Assert.True(names.Length >= 4, printed)
                Assert.Equal(names.Length, names.Distinct(StringComparer.Ordinal).Count())
                if previous != nil {
                    Assert.Equal(Encoding.UTF8.GetBytes(previous), Encoding.UTF8.GetBytes(printed))
                }
                previous = printed
            }
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_NestedTypeEffectiveHelpersReserveTheirActualOwner(specialFirst bool) {
        let first = CSharpSyntaxTree.ParseText(
            "public partial class Outer { public static partial class Inner { public static int First() { return 1; } } }",
            path: "AOuter.cs"
        )
        let second = CSharpSyntaxTree.ParseText(
            "public partial class Outer { public static partial class Inner { public static int Second() { return item(1); static int item(int n) => n == 0 ? 7 : OtherB<int>(n - 1); static int OtherB<T>(int n) => item(n); } } } " +
                "public static class Demo { public static string Run() => Outer.Inner.First() + \":\" + Outer.Inner.Second(); }",
            path: "BInner.cs"
        )
        let outputs = Dictionary[bool, string]()
        for var fresh = 0; fresh < 2; fresh++ {
            let compilation = CSharpCompilation.Create(
                "NestedEffectiveHelperOwner5326",
                []SyntaxTree{first, second},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let normal = compilation.GetSemanticModel(first)
            let original = first
                .GetRoot()
                .DescendantNodes()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax]()
                .Single()
            let special = CreateSpeculativeBodyModel(
                normal,
                original,
                "public static int First() { return item(1); static int item(int n) => n == 0 ? 42 : OtherA<int>(n - 1); static int OtherA<T>(int n) => item(n); }"
            )
            let firstMode = if fresh == 0 {
                specialFirst
            } else {
                !specialFirst
            }
            for isSpecial in[]bool{firstMode, !firstMode, firstMode} {
                for reverse in(
                    if fresh == 0 {
                        []bool{false, true}
                    } else {
                        []bool{true, false}
                    }
                ) {
                    let translator = CSharpToGSharpTranslator()
                    let printed = Dictionary[string, string](StringComparer.Ordinal)
                    for current in(
                        if reverse {
                            []SyntaxTree{second, first}
                        } else {
                            []SyntaxTree{first, second}
                        }
                    ) {
                        printed[current.FilePath] = GSharpPrinter.Print(
                            translator.TranslateDocument(
                                LoadedDocument(current.FilePath, current, compilation.GetSemanticModel(current)),
                                TranslationContext(
                                    compilation,
                                    if isSpecial {
                                        special
                                    } else {
                                        normal
                                    },
                                    current.FilePath
                                )
                            )
                        )
                    }
                    let output = printed[first.FilePath] + "\n" + printed[second.FilePath]
                    Assert.Contains("func item", output)
                    Assert.Equal(
                        Encoding.UTF8.GetBytes(
                            (
                                if isSpecial {
                                    "42:7"
                                } else {
                                    "1:7"
                                }
                            ) +
                                Environment.NewLine
                        ),
                        Encoding.UTF8.GetBytes(CompileAndRun(output, Array.Empty[byte](), strictIl: true))
                    )
                    if outputs.TryGetValue(isSpecial, out var previous) {
                        Assert.Equal(Encoding.UTF8.GetBytes(previous), Encoding.UTF8.GetBytes(output))
                    } else {
                        outputs.Add(isSpecial, output)
                    }
                }
            }
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func RefParameter_EffectiveConstructorOverwritePreservesFreshArrayIdentity(
        replacementReads bool,
        specialFirst bool
    ) {
        let observe = "SawShared = System.Object.ReferenceEquals(items, System.Array.Empty<int>()); "
        let tree = CSharpSyntaxTree.ParseText(
            "public sealed class Owner { public int[] items; public bool SawShared; public Owner() { " +
                (
                if replacementReads {
                    ""
                } else {
                    observe
                }
            ) +
                "items = new int[1]; } public Owner(int control) { items = new int[2]; } } " +
                "public static class Demo { public static string Run() { var other = new Owner(2); var value = new Owner(); return value.SawShared.ToString() + \":\" + other.items.Length; } }",
            path: "SpeculativeArrayConstructor.cs"
        )
        let compilation = CSharpCompilation.Create(
            "SpeculativeArrayConstructor5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let original = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax]()
            .Single(
            (ctor Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax) -> ctor
                .ParameterList
                .Parameters
                .Count == 0
        )
        let special = CreateSpeculativeBodyModel(
            normal,
            original,
            "public Owner() { " +
                (
                if replacementReads {
                    observe
                } else {
                    ""
                }
            ) +
                "items = new int[1]; }"
        )
        let normalContext = TranslationContext(compilation, normal, tree.FilePath)
        let specialContext = TranslationContext(compilation, special, tree.FilePath)
        using let enclosing = ObliviousNullabilityAnalyzer.UseCatalogScope(specialContext)
        for isSpecial in[]bool{specialFirst, !specialFirst, specialFirst} {
            let context = if isSpecial {
                specialContext
            } else {
                normalContext
            }
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, normal), context)
            )
            Assert.Equal(
                Encoding.UTF8.GetBytes("False:2" + Environment.NewLine),
                Encoding.UTF8.GetBytes(CompileAndRun(printed, Array.Empty[byte](), strictIl: true))
            )
            let observes = if isSpecial {
                replacementReads
            } else {
                !replacementReads
            }
            Assert.Equal(!observes, Regex.IsMatch(printed, "items\\s+\\[\\]int32\\s*=\\s*(?:System\\.)?Array.Empty"))
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func RefParameter_EffectiveRecordConstructorFeedsLiteralAndPrimaryPlans(replacementSwaps bool, specialFirst bool) {
        let straight = "First = first; Second = second;"
        let swapped = "First = second; Second = first;"
        let tree = CSharpSyntaxTree.ParseText(
            "public record struct Pair { public int First; public int Second; public Pair(int first, int second) { " +
                (
                if replacementSwaps {
                    straight
                } else {
                    swapped
                }
            ) +
                " } } " +
                "public struct Other { public int Value; public Other(int value) { Value = value; } } " +
                "public static class SourceProbe { private static int order; private static int Next(int value) { order = order * 10 + value; return value; } " +
                "public static string Run() { order = 0; var value = new Pair(Next(1), Next(2)); return value.First + \":\" + value.Second + \":\" + order + \":\" + new Other(9).Value; } }",
            path: "SpeculativeRecordConstructor.cs"
        )
        let compilation = CSharpCompilation.Create(
            "SpeculativeRecordConstructor5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let original = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax]()
            .Single(
            (ctor Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax) -> ctor
                .Identifier
                .ValueText == "Pair"
        )
        let special = CreateSpeculativeBodyModel(
            normal,
            original,
            "public Pair(int first, int second) { " +
                (
                if replacementSwaps {
                    swapped
                } else {
                    straight
                }
            ) +
                " }"
        )
        let normalContext = TranslationContext(compilation, normal, tree.FilePath)
        let specialContext = TranslationContext(compilation, special, tree.FilePath)
        using let enclosing = ObliviousNullabilityAnalyzer.UseCatalogScope(specialContext)
        for isSpecial in[]bool{specialFirst, !specialFirst, specialFirst} {
            let expectedSwaps = if isSpecial {
                replacementSwaps
            } else {
                !replacementSwaps
            }
            let context = if isSpecial {
                specialContext
            } else {
                normalContext
            }
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, normal), context)
            )
            let runtime = printed +
                "\npublic class Demo { shared { public func Run() string { let value = Pair(1, 2)\n" +
                "return SourceProbe.Run() + \":\" + value.First.ToString() + \":\" + value.Second.ToString()\n} } }\n"
            let values = if expectedSwaps {
                "2:1"
            } else {
                "1:2"
            }
            Assert.Equal(
                Encoding.UTF8.GetBytes(values + ":12:9:" + values + Environment.NewLine),
                Encoding.UTF8.GetBytes(CompileAndRun(runtime, Array.Empty[byte](), strictIl: true))
            )
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_EffectiveHelperPreallocationIsDocumentOrderAndModelStable(specialFirst bool) {
        let first = CSharpSyntaxTree.ParseText(
            "public static partial class Demo { public static int Read() { return 1; } }",
            path: "AHelper.cs"
        )
        let second = CSharpSyntaxTree.ParseText(
            "public static partial class Demo { public static System.Collections.Generic.IEnumerable<int[]> Values() { yield return new int[1]; } " +
                "public static string Run() { foreach(var value in Values()) return Read() + \":\" + value.Length; return \"empty\"; } }",
            path: "BIterator.cs"
        )
        let results = Dictionary[bool, string]()
        for var fresh = 0; fresh < 2; fresh++ {
            let compilation = CSharpCompilation.Create(
                "SpeculativeHelperNames5326",
                []SyntaxTree{first, second},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let normal = compilation.GetSemanticModel(first)
            let original = first
                .GetRoot()
                .DescendantNodes()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax]()
                .Single()
            let special = CreateSpeculativeBodyModel(
                normal,
                original,
                "public static int Read() { int item(int n) { return n == 0 ? 42 : item(n - 1); } return item(1); }"
            )
            let firstMode = if fresh == 0 {
                specialFirst
            } else {
                !specialFirst
            }
            for isSpecial in[]bool{firstMode, !firstMode, firstMode} {
                let model = if isSpecial {
                    special
                } else {
                    normal
                }
                for reverse in(
                    if fresh == 0 {
                        []bool{false, true}
                    } else {
                        []bool{true, false}
                    }
                ) {
                    let translator = CSharpToGSharpTranslator()
                    let printed = Dictionary[string, string](StringComparer.Ordinal)
                    for tree in(
                        if reverse {
                            []SyntaxTree{second, first}
                        } else {
                            []SyntaxTree{first, second}
                        }
                    ) {
                        printed[tree.FilePath] = GSharpPrinter.Print(
                            translator.TranslateDocument(
                                LoadedDocument(tree.FilePath, tree, compilation.GetSemanticModel(tree)),
                                TranslationContext(compilation, model, tree.FilePath)
                            )
                        )
                    }
                    let output = printed[first.FilePath] + "\n" + printed[second.FilePath]
                    if results.TryGetValue(isSpecial, out var previous) {
                        Assert.Equal(Encoding.UTF8.GetBytes(previous), Encoding.UTF8.GetBytes(output))
                    } else {
                        results.Add(isSpecial, output)
                    }
                    Assert.Equal(
                        Encoding.UTF8.GetBytes(
                            (
                                if isSpecial {
                                    "42:1"
                                } else {
                                    "1:1"
                                }
                            ) +
                                Environment.NewLine
                        ),
                        Encoding.UTF8.GetBytes(CompileAndRun(output, Array.Empty[byte](), strictIl: true))
                    )
                    GC.Collect()
                    GC.WaitForPendingFinalizers()
                    GC.Collect()
                }
            }
        }
    }

    private func CreateSpeculativeBodyModel(
        normal SemanticModel,
        original Microsoft.CodeAnalysis.CSharp.Syntax.BaseMethodDeclarationSyntax,
        replacementText string
    ) SemanticModel {
        let replacement = Assert.IsAssignableFrom[Microsoft.CodeAnalysis.CSharp.Syntax.BaseMethodDeclarationSyntax](
            SyntaxFactory.ParseMemberDeclaration(replacementText)
        )
        Assert.True(
            Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpExtensions
                .TryGetSpeculativeSemanticModelForMethodBody(
                normal,
                original.Body!!.SpanStart,
                replacement,
                out var speculative
            )
        )
        return speculative ?? throw InvalidOperationException("Speculative model missing.")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_SpeculativeConstructorFactsPrecedeInitializerFolding(replacementFolds bool) {
        let folded = "Slot = \"from-literal\";"
        let unfolded = "Slot = Touch();"
        let tree = CSharpSyntaxTree.ParseText(
            "public static class Demo { public static string Slot = \"initial\"; static Demo() { " +
                (
                if replacementFolds {
                    unfolded
                } else {
                    folded
                }
            ) +
                " } private static string Touch() => \"from-call\"; public static string Run() => Slot; }",
            path: "SpeculativeConstructorFacts.cs"
        )
        let compilation = CSharpCompilation.Create(
            "SpeculativeConstructorFacts5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let original = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax]()
            .Single()
        let replacement = Assert.IsAssignableFrom[Microsoft.CodeAnalysis.CSharp.Syntax.BaseMethodDeclarationSyntax](
            SyntaxFactory.ParseMemberDeclaration(
                "static Demo() { " +
                    (
                    if replacementFolds {
                        folded
                    } else {
                        unfolded
                    }
                ) +
                    " }"
            )
        )
        Assert.True(
            Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpExtensions
                .TryGetSpeculativeSemanticModelForMethodBody(
                normal,
                original.Body!!.SpanStart,
                replacement,
                out var speculative
            )
        )
        let supplied = speculative ?? throw InvalidOperationException("Speculative model missing.")
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                LoadedDocument(tree.FilePath, tree, normal),
                TranslationContext(compilation, supplied, tree.FilePath)
            )
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                (
                    if replacementFolds {
                        "from-literal"
                    } else {
                        "from-call"
                    }
                ) +
                    Environment.NewLine
            ),
            Encoding.UTF8.GetBytes(CompileAndRun(printed, Array.Empty[byte](), strictIl: true))
        )
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func RefParameter_SpeculativeIteratorFactsPrecedeSignatureMapping(replacementYields bool, specialFirst bool) {
        let iterator = "yield return null;"
        let ordinary = "return new[] { \"safe\" };"
        let tree = CSharpSyntaxTree.ParseText(
            "using System.Collections.Generic; public static class Demo { public static IEnumerable<string> Items() { " +
                (
                if replacementYields {
                    ordinary
                } else {
                    iterator
                }
            ) +
                " } public static string Keep() => \"other\"; public static string Run() { foreach(var value in Items()) return (value ?? \"nil\") + \":\" + Keep(); return \"empty\"; } }",
            path: "SpeculativeIteratorSignature.cs"
        )
        let compilation = CSharpCompilation.Create(
            "SpeculativeIteratorSignature5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let original = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax]()
            .Single(
            (method Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax) -> method
                .Identifier
                .ValueText == "Items"
        )
        let replacement = Assert.IsAssignableFrom[Microsoft.CodeAnalysis.CSharp.Syntax.BaseMethodDeclarationSyntax](
            SyntaxFactory.ParseMemberDeclaration(
                "public static IEnumerable<string> Items() { " +
                    (
                    if replacementYields {
                        iterator
                    } else {
                        ordinary
                    }
                ) +
                    " }"
            )
        )
        Assert.True(
            Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpExtensions
                .TryGetSpeculativeSemanticModelForMethodBody(
                normal,
                original.Body!!.SpanStart,
                replacement,
                out var speculativeModel
            )
        )
        let supplied = speculativeModel ?? throw InvalidOperationException("Speculative model missing.")
        let normalContext = TranslationContext(compilation, normal, tree.FilePath)
        let specialContext = TranslationContext(compilation, supplied, tree.FilePath)
        for isSpecial in[]bool{specialFirst, !specialFirst, specialFirst} {
            let context = if isSpecial {
                specialContext
            } else {
                normalContext
            }
            using let active = ObliviousNullabilityAnalyzer.UseCatalogScope(context)
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, normal), context)
            )
            let expectedYields = if isSpecial {
                replacementYields
            } else {
                !replacementYields
            }
            Assert.Equal(
                Encoding.UTF8.GetBytes(
                    (
                        if expectedYields {
                            "nil:other"
                        } else {
                            "safe:other"
                        }
                    ) +
                        Environment.NewLine
                ),
                Encoding.UTF8.GetBytes(CompileAndRun(printed, Array.Empty[byte](), strictIl: true))
            )
            Assert.Contains(
                if expectedYields {
                    "func Items() sequence[string?]"
                } else {
                    "func Items() IEnumerable[string]"
                },
                printed
            )
        }
    }

    @Theory
    @InlineData(false, false, false)
    @InlineData(false, true, false)
    @InlineData(true, false, false)
    @InlineData(true, true, false)
    @InlineData(false, false, true)
    @InlineData(false, true, true)
    @InlineData(true, false, true)
    @InlineData(true, true, true)
    func RefParameter_SpeculativeMemberScopesUseEffectiveFieldAndPropertyComparisons(
        replacementCompares bool,
        specialFirst bool,
        partialOwner bool
    ) {
        let comparison = "if (field != null) {} if (Property != null) {}"
        let members = "private static Box field = new Box(); private static Box Property {get;set;} = new Box(); private static Box Other = new Box(); public static void Keep() { if (Other != null) {} } public static string Run() { Change(); Keep(); return \"ok\"; }"
        let tree = CSharpSyntaxTree.ParseText(
            "#nullable enable\n" +
                (
                if partialOwner {
                    "public static partial class Demo { "
                } else {
                    "public class Box {} public static class Demo { " + members
                }
            ) +
                " public static void Change() { " +
                (
                if replacementCompares {
                    ""
                } else {
                    comparison
                }
            ) +
                " } }",
            path: "SpeculativeMemberScope.cs"
        )
        let trees = if partialOwner {
            []SyntaxTree{
                CSharpSyntaxTree.ParseText(
                    "#nullable enable\npublic class Box {} public static partial class Demo { " + members + " }",
                    path: "SpeculativeMemberDefinitions.cs"
                ),
                tree
            }
        } else {
            []SyntaxTree{tree}
        }
        let compilation = CSharpCompilation.Create(
            "SpeculativeMemberScope5326",
            trees,
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let original = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax]()
            .Single(
            (method Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax) -> method
                .Identifier
                .ValueText == "Change"
        )
        let replacement = Assert.IsAssignableFrom[Microsoft.CodeAnalysis.CSharp.Syntax.BaseMethodDeclarationSyntax](
            SyntaxFactory.ParseMemberDeclaration(
                "public static void Change() { " +
                    (
                    if replacementCompares {
                        comparison
                    } else {
                        ""
                    }
                ) +
                    " }"
            )
        )
        Assert.True(
            Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpExtensions
                .TryGetSpeculativeSemanticModelForMethodBody(
                normal,
                original.Body!!.SpanStart,
                replacement,
                out var speculativeModel
            )
        )
        let supplied = speculativeModel ?? throw InvalidOperationException("Speculative model missing.")
        for isSpecial in[]bool{specialFirst, !specialFirst, specialFirst} {
            let model = if isSpecial {
                supplied
            } else {
                normal
            }
            let translator = CSharpToGSharpTranslator()
            let printed = string.Join(
                "\n",
                trees.Select(
                    (current SyntaxTree) ->
                    GSharpPrinter.Print(
                        translator.TranslateDocument(
                            LoadedDocument(current.FilePath, current, compilation.GetSemanticModel(current)),
                            TranslationContext(compilation, model, current.FilePath)
                        )
                    )
                )
            )
            let expected = if isSpecial {
                replacementCompares
            } else {
                !replacementCompares
            }
            Assert.Equal(expected, printed.Contains("field Box?", StringComparison.Ordinal))
            Assert.Equal(expected, printed.Contains("Property Box?", StringComparison.Ordinal))
            Assert.Contains("Other Box?", printed)
            Assert.Equal(
                Encoding.UTF8.GetBytes("ok" + Environment.NewLine),
                Encoding.UTF8.GetBytes(CompileAndRun(printed, Array.Empty[byte](), strictIl: true))
            )
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func RefParameter_SpeculativeInventoriesReplaceNullSeedsRefEdgesAndAnonymousShapes(
        replacementWritesNull bool,
        specialFirst bool
    ) {
        let changed = "Use(null); Ref(ref Slot); var shape = new { Item = (string)null };"
        let unchanged = "Use(\"safe\"); var shape = new { Item = \"safe\" };"
        let tree = CSharpSyntaxTree.ParseText(
            "public static class Demo { public static string Slot = \"safe\"; private static void Use(string text) {} private static void Ref(ref string value) {} public static object Stable() => new { Item = \"safe\" }; public static void Change() { " +
                (
                if replacementWritesNull {
                    unchanged
                } else {
                    changed
                }
            ) +
                " } public static string Run() { Change(); return \"ok\"; } }",
            path: "SpeculativeAllInventories.cs"
        )
        let compilation = CSharpCompilation.Create(
            "SpeculativeAllInventories5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let original = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax]()
            .Single(
            (method Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax) -> method
                .Identifier
                .ValueText == "Change"
        )
        let replacement = Assert.IsAssignableFrom[Microsoft.CodeAnalysis.CSharp.Syntax.BaseMethodDeclarationSyntax](
            SyntaxFactory.ParseMemberDeclaration(
                "public static void Change() { " +
                    (
                    if replacementWritesNull {
                        changed
                    } else {
                        unchanged
                    }
                ) +
                    " }"
            )
        )
        Assert.True(
            Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpExtensions
                .TryGetSpeculativeSemanticModelForMethodBody(
                normal,
                original.Body!!.SpanStart,
                replacement,
                out var speculativeModel
            )
        )
        let supplied = speculativeModel ?? throw InvalidOperationException("Speculative model missing.")
        let owner = compilation.GetTypeByMetadataName("Demo") ?? throw InvalidOperationException("Demo missing.")
        let input = Assert.IsAssignableFrom[IMethodSymbol](Assert.Single(owner.GetMembers("Use"))).Parameters[0]
        let normalContext = TranslationContext(compilation, normal, tree.FilePath)
        let specialContext = TranslationContext(compilation, supplied, tree.FilePath)
        var normalConnected = false
        var specialConnected = false
        normalContext.AfterRefStorageConnection = (target ISymbol, source ISymbol) -> {
            if target is IParameterSymbol{Name: "value"} && source is IFieldSymbol{Name: "Slot"} {
                normalConnected = true
            }
        }
        specialContext.AfterRefStorageConnection = (target ISymbol, source ISymbol) -> {
            if target is IParameterSymbol{Name: "value"} && source is IFieldSymbol{Name: "Slot"} {
                specialConnected = true
            }
        }
        for isSpecial in[]bool{specialFirst, !specialFirst, specialFirst} {
            let model = if isSpecial {
                supplied
            } else {
                normal
            }
            let context = if isSpecial {
                specialContext
            } else {
                normalContext
            }
            let expected = if isSpecial {
                replacementWritesNull
            } else {
                !replacementWritesNull
            }
            using let analysis = ObliviousNullabilityAnalyzer.UseCatalogScope(context)
            Assert.Equal(
                expected,
                ObliviousNullabilityAnalyzer.IsNullArgumentTarget(compilation, input, context.SiblingCompilations)
            )
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, normal), context)
            )
            Assert.Equal(
                expected,
                if isSpecial {
                    specialConnected
                } else {
                    normalConnected
                }
            )
            Assert.Equal(expected, Regex.IsMatch(printed, "data class [^\\n]+\\(Item string\\?\\)"))
            Assert.Equal(
                Encoding.UTF8.GetBytes("ok" + Environment.NewLine),
                Encoding.UTF8.GetBytes(CompileAndRun(printed, Array.Empty[byte](), strictIl: true))
            )
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_SpeculativeBodyOverlayExecutesReplacementNotOriginal(replacementNull bool) {
        let originalWrite = if replacementNull {
            "Value = \"safe\";"
        } else {
            "Value = null;"
        }
        let replacementWrite = if replacementNull {
            "Value = null;"
        } else {
            "Value = \"safe\";"
        }
        let tree = CSharpSyntaxTree.ParseText(
            "public static class Demo { public static string Value = \"safe\"; public static string Other = \"before\"; public static void Change() { " +
                originalWrite +
                " } public static void Keep() { Other = \"other\"; } public static string Run() { Change(); Keep(); return (Value ?? \"nil\") + \":\" + Other; } }",
            path: "SpeculativeRuntime.cs"
        )
        let compilation = CSharpCompilation.Create(
            "SpeculativeRuntime5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let original = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax]()
            .Single(
            (method Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax) -> method
                .Identifier
                .ValueText == "Change"
        )
        let replacement = Assert.IsAssignableFrom[Microsoft.CodeAnalysis.CSharp.Syntax.BaseMethodDeclarationSyntax](
            SyntaxFactory.ParseMemberDeclaration("public static void Change() { " + replacementWrite + " }")
        )
        Assert.True(
            Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpExtensions
                .TryGetSpeculativeSemanticModelForMethodBody(
                normal,
                original.Body!!.SpanStart,
                replacement,
                out var speculativeModel
            )
        )
        let supplied = speculativeModel ?? throw InvalidOperationException("Speculative model missing.")
        let context = TranslationContext(compilation, supplied, tree.FilePath)
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, normal), context)
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                (
                    if replacementNull {
                        "nil:other"
                    } else {
                        "safe:other"
                    }
                ) +
                    Environment.NewLine
            ),
            Encoding.UTF8.GetBytes(CompileAndRun(printed, Array.Empty[byte](), strictIl: true))
        )
        let peer = TranslationContext(compilation, normal, tree.FilePath)
        let originalOutput = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, normal), peer)
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                (
                    if replacementNull {
                        "safe:other"
                    } else {
                        "nil:other"
                    }
                ) +
                    Environment.NewLine
            ),
            Encoding.UTF8.GetBytes(CompileAndRun(originalOutput, Array.Empty[byte](), strictIl: true))
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_ProducerOwnedExtensionInheritsCancellationAndSuppliedBindings(special bool) {
        let producerTree = CSharpSyntaxTree.ParseText(
            "namespace Lib5617 { public class Box {} public static class Extensions { public static int Size(this Box box) => 7; } }",
            path: "ProducerOwnedExtension.cs"
        )
        let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        let producer = CSharpCompilation.Create(
            "Lib5617",
            []SyntaxTree{producerTree},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let tree = CSharpSyntaxTree.ParseText(
            "using Lib5617; public class Secret { private static int Value = 1; } public static class Demo { public static int Read() => Secret.Value; public static string Run() => new Box().Size().ToString(); }",
            path: "OwnedExtensionCaller.cs"
        )
        let compilation = CSharpCompilation.Create(
            "OwnedExtensionCaller5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences().Append(cast[MetadataReference](producer.ToMetadataReference())),
            options
        )
        let model = compilation.GetSemanticModel(tree, ignoreAccessibility: special)
        let privateRead = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax]()
            .Single(
            (
                access Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax
            ) -> access.ToString() == "Secret.Value"
        )
        using let cancellation = CancellationTokenSource()
        let catalog = List[CSharpCompilation]{compilation, producer}
        let context = TranslationContext(compilation, model, tree.FilePath, catalog, catalog, cancellation.Token)
        var entered = false
        var publishedAfterCancellation = false
        context.BeforeProducerExtensionAnalysis = (child TranslationContext) -> {
            entered = true
            {
                using let caller = child.UseSemanticModelFor(tree, compilation)
                Assert.Equal(special, child.GetSymbolInfo(privateRead).Symbol != nil)
            }
            child.BeforeRefStoragePublication = () -> {
                publishedAfterCancellation = true
            }
            cancellation.Cancel()
        }
        Assert.ThrowsAny[OperationCanceledException](
            () -> CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
        )
        Assert.True(entered)
        Assert.False(publishedAfterCancellation)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_PrivateRefStorageConsumesTheSuppliedModel(specialFirst bool) {
        let tree = CSharpSyntaxTree.ParseText(`
public static class Secrets { private static string Storage = null; }
public static class Demo {
    private static void Set(ref string value) {}
    public static void Probe() { Set(ref Secrets.Storage); }
}`, path: "PrivateRefStorage.cs")
        let compilation = CSharpCompilation.Create(
            "PrivateRefStorage5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let special = compilation.GetSemanticModel(tree, ignoreAccessibility: true)
        let member = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax]()
            .Single()
        Assert.Null(normal.GetSymbolInfo(member).Symbol)
        Assert.NotNull(special.GetSymbolInfo(member).Symbol)
        let normalContext = TranslationContext(compilation, normal, tree.FilePath)
        let specialContext = TranslationContext(compilation, special, tree.FilePath)
        let normalEdges = List[(Target ISymbol, Source ISymbol)]()
        let specialEdges = List[(Target ISymbol, Source ISymbol)]()
        normalContext.AfterRefStorageConnection = (target ISymbol, source ISymbol) -> normalEdges.Add((target, source))
        specialContext.AfterRefStorageConnection = (target ISymbol, source ISymbol) -> specialEdges.Add(
            (target, source)
        )
        for isSpecial in[]bool{specialFirst, !specialFirst, specialFirst} {
            let context = if isSpecial {
                specialContext
            } else {
                normalContext
            }
            let model = if isSpecial {
                special
            } else {
                normal
            }
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
            )
            Assert.Equal(isSpecial, printed.Contains("func Set(ref value string?)", StringComparison.Ordinal))
            let edges = if isSpecial {
                specialEdges
            } else {
                normalEdges
            }
            Assert.Equal(
                isSpecial,
                edges.Any(
                    (edge(Target ISymbol, Source ISymbol)) ->
                    edge.Target is IParameterSymbol{Name: "value"} &&
                        edge.Source is IFieldSymbol{Name: "Storage"} &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(edge.Source, special.GetSymbolInfo(member).Symbol)
                )
            )
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_PrivateNullFlowUsesScopedSeedsAndTupleBindings(specialFirst bool) {
        let tree = CSharpSyntaxTree.ParseText(`
public static class Secrets {
    private static string Value = "safe";
    private static (string First, string Second) Pair = ("safe", "safe");
    private static void Accept(string value) {}
}
public static class Demo {
    public static void Mutate() { Secrets.Value = null; Secrets.Pair = (null, "safe"); Secrets.Accept(null); }
    public static string Read() => Secrets.Value;
}`, path: "PrivateNullFlow.cs")
        let compilation = CSharpCompilation.Create(
            "PrivateNullFlow5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let special = compilation.GetSemanticModel(tree, ignoreAccessibility: true)
        let secrets = compilation.GetTypeByMetadataName("Secrets") ??
            throw InvalidOperationException("Secrets missing.")
        let value = Assert.IsAssignableFrom[IFieldSymbol](Assert.Single(secrets.GetMembers("Value")))
        let pair = Assert.IsAssignableFrom[IFieldSymbol](Assert.Single(secrets.GetMembers("Pair")))
        let parameter = Assert.IsAssignableFrom[IMethodSymbol](Assert.Single(secrets.GetMembers("Accept")))
            .Parameters[0]
        let read = Assert.IsAssignableFrom[IMethodSymbol](
            Assert.Single(
                (
                    compilation.GetTypeByMetadataName("Demo") ?? throw InvalidOperationException("Demo missing.")
                ).GetMembers("Read")
            )
        )
        let access = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax]()
            .First(
            (
                member Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax
            ) -> member.ToString() == "Secrets.Value"
        )
        Assert.Null(normal.GetSymbolInfo(access).Symbol)
        Assert.NotNull(special.GetSymbolInfo(access).Symbol)
        let normalContext = TranslationContext(compilation, normal, tree.FilePath)
        let specialContext = TranslationContext(compilation, special, tree.FilePath)
        for isSpecial in[]bool{specialFirst, !specialFirst, specialFirst} {
            let context = if isSpecial {
                specialContext
            } else {
                normalContext
            }
            let model = if isSpecial {
                special
            } else {
                normal
            }
            using let analysis = ObliviousNullabilityAnalyzer.UseCatalogScope(context)
            Assert.Equal(
                isSpecial,
                ObliviousNullabilityAnalyzer.IsNullArgumentTarget(compilation, parameter, context.SiblingCompilations)
            )
            Assert.Equal(isSpecial, ObliviousNullabilityAnalyzer.IsTainted(compilation, value))
            Assert.Equal(isSpecial, ObliviousNullabilityAnalyzer.IsTainted(compilation, read))
            Assert.Equal(
                isSpecial,
                ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                    compilation,
                    pair,
                    []int32{0},
                    context.SiblingCompilations
                )
            )
            Assert.Equal(
                isSpecial,
                ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                    compilation,
                    pair,
                    []int32{0},
                    List[CSharpCompilation]{compilation}
                )
            )
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
            )
            Assert.Equal(isSpecial, printed.Contains("func Read() string?", StringComparison.Ordinal))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_PrivateAnonymousInitializerUsesTheScopedShapeEvidence(specialFirst bool) {
        let tree = CSharpSyntaxTree.ParseText(`
#nullable enable
public static class Secrets { private static string? Read() => null; }
public static class Demo {
    public static object Make() {
        var first = new { Item = "safe" };
        var second = new { Item = Secrets.Read() };
        return first;
    }
}`, path: "PrivateAnonymousShape.cs")
        let compilation = CSharpCompilation.Create(
            "PrivateAnonymousShape5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let normal = compilation.GetSemanticModel(tree)
        let special = compilation.GetSemanticModel(tree, ignoreAccessibility: true)
        let call = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax]()
            .Single()
        Assert.Null(normal.GetSymbolInfo(call).Symbol)
        Assert.NotNull(special.GetSymbolInfo(call).Symbol)
        let sharedMapper = CSharpTypeMapper()
        for isSpecial in[]bool{specialFirst, !specialFirst, specialFirst} {
            let model = if isSpecial {
                special
            } else {
                normal
            }
            let context = TranslationContext(compilation, model, tree.FilePath)
            let firstCreation = tree
                .GetRoot()
                .DescendantNodes()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.AnonymousObjectCreationExpressionSyntax]()
                .First()
            using let analysis = ObliviousNullabilityAnalyzer.UseCatalogScope(context)
            let shared = sharedMapper.GetOrCreateAnonymousDataClassShape(
                model.GetTypeInfo(firstCreation).Type as INamedTypeSymbol,
                context,
                firstCreation.GetLocation()
            )
            let propertyTypes = shared.PropertyTypes ??
                throw InvalidOperationException("Anonymous property contract missing.")
            Assert.Equal(isSpecial, Assert.Single(propertyTypes).IsNullable)
            Assert.Same(
                propertyTypes,
                sharedMapper.GetOrCreateAnonymousDataClassShape(
                    model.GetTypeInfo(firstCreation).Type as INamedTypeSymbol,
                    context,
                    firstCreation.GetLocation()
                )
                    .PropertyTypes
            )
            let directMapper = CSharpTypeMapper()
            directMapper.Map(model.GetTypeInfo(firstCreation).Type, context, firstCreation.GetLocation())
            let declaration = Assert.Single(directMapper.PendingAnonymousDataClasses)
            let parameter = Assert.Single(
                declaration.PrimaryConstructorParameters ??
                    throw InvalidOperationException("Anonymous constructor missing.")
            )
            Assert.Equal(isSpecial, parameter.Type.IsNullable)
            let contract = GSharpPrinter.Print(
                Cs2Gs.CodeModel.Ast.CompilationUnit(members: []Cs2Gs.CodeModel.Ast.GNode{declaration})
            )
            let argument = if isSpecial {
                "nil"
            } else {
                "\"safe\""
            }
            let result = if isSpecial {
                "if value.Item == nil { \"nil\" } else { \"wrong\" }"
            } else {
                "value.Item"
            }
            let runtime = contract +
                "\npublic class Demo {\nshared {\npublic func Run() string {\nlet value = " +
                declaration.Name +
                "(" +
                argument +
                ")\nreturn " +
                result +
                "\n}\n}\n}\n"
            Assert.Equal(
                Encoding.UTF8.GetBytes(
                    (
                        if isSpecial {
                            "nil"
                        } else {
                            "safe"
                        }
                    ) +
                        Environment.NewLine
                ),
                Encoding.UTF8.GetBytes(CompileAndRun(runtime, Array.Empty[byte](), strictIl: true))
            )
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
            )
            Assert.Equal(isSpecial, Regex.IsMatch(printed, "data class [^\\n]+\\(Item string\\?\\)"))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_AnonymousMergeCacheUsesActualCompilation(nullableFirst bool) {
        let tree = CSharpSyntaxTree.ParseText(`
#nullable enable
public static class Demo {
    public static object Make() {
        var first = new { Item = "safe" };
        var second = new { Item = Provider.Read() };
        return first;
    }
}`, path: "SharedAnonymous.cs")
        let Build = (nullable bool) -> CSharpCompilation.Create(
            "SameAnonymousAssembly5326",
            []SyntaxTree{
                tree,
                CSharpSyntaxTree.ParseText(
                    if nullable {
                        "#nullable enable\npublic static class Provider { public static string? Read() => null; }"
                    } else {
                        "#nullable enable\npublic static class Provider { public static string Read() => \"safe\"; }"
                    },
                    path: "Provider.cs"
                )
            },
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let nullableCompilation = Build(true)
        let nonnullableCompilation = Build(false)
        Assert.NotSame(nullableCompilation, nonnullableCompilation)
        Assert.Equal(nullableCompilation.Assembly.Identity, nonnullableCompilation.Assembly.Identity)
        let mapper = CSharpTypeMapper()
        var incomingSpelling string? = nil
        let creation = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.AnonymousObjectCreationExpressionSyntax]()
            .First()
        for nullable in[]bool{nullableFirst, !nullableFirst, nullableFirst} {
            let compilation = if nullable {
                nullableCompilation
            } else {
                nonnullableCompilation
            }
            let model = compilation.GetSemanticModel(tree)
            let context = TranslationContext(compilation, model, tree.FilePath)
            let type = Assert.IsAssignableFrom[INamedTypeSymbol](model.GetTypeInfo(creation).Type)
            let property = Assert.Single(type.GetMembers().OfType[IPropertySymbol]())
            let spelling = GSharpPrinter.RenderTypeReference(
                mapper.Map(property.Type, context, creation.GetLocation()) ??
                    throw InvalidOperationException("Incoming mapping missing.")
            )
            if incomingSpelling != nil {
                Assert.Equal(incomingSpelling, spelling)
            }
            incomingSpelling = spelling
            let shape = mapper.GetOrCreateAnonymousDataClassShape(type, context, creation.GetLocation())
            Assert.Equal(
                nullable,
                Assert.Single(shape.PropertyTypes ?? throw InvalidOperationException("Property contract missing."))
                    .IsNullable
            )
            Assert.Same(
                shape.PropertyTypes,
                mapper.GetOrCreateAnonymousDataClassShape(type, context, creation.GetLocation()).PropertyTypes
            )
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_SpecialSuppliedModelsKeepTheirBoundCallbackAndProjectionInventories(specialFirst bool) {
        let tree = CSharpSyntaxTree.ParseText(`
using System;
using System.Collections.Generic;
using System.Linq;
using Gsharp.Values;
public class Bucket<T> : List<ManagedRef<T>> where T : class { public Bucket() {} public void PublicObserve() {} private void Observe() {} }
public static class Secrets {
    private static IEqualityComparer<int> Make() => EqualityComparer<int>.Create((x,y) => x == y, x => { Demo.Global = null; return x; });
}
public static class Demo {
    public static string? Global;
    private static Dictionary<int,int> table = new Dictionary<int,int>(Secrets.Make());
    private static void Probe() { _ = Enumerable.Count(new[] {1}); _ = table.ContainsKey(1); }
    private static int Guard(ref string? value) { if(value == null)return 0; Probe(); return value.Length; }
    public static void Project(Bucket<string> bucket) { bucket.PublicObserve(); bucket.Observe(); }
    public static string Run() { Global = "safe"; return Guard(ref Global).ToString(); }
}`, path: "SpecialModelInventory.cs")
        let compilation = CSharpCompilation.Create(
            "SpecialModelInventory5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences().Append(
                cast[MetadataReference](
                    MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)
                )
            ),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
        let normal = compilation.GetSemanticModel(tree)
        let special = compilation.GetSemanticModel(tree, ignoreAccessibility: true)
        let factory = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax]()
            .Single(
            (
                call Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax
            ) -> call.ToString() == "Secrets.Make()"
        )
        let projected = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax]()
            .Single(
            (
                call Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax
            ) -> call.ToString() == "bucket.Observe()"
        )
        Assert.Null(normal.GetSymbolInfo(factory).Symbol)
        Assert.NotNull(special.GetSymbolInfo(factory).Symbol)
        Assert.Null(normal.GetSymbolInfo(projected).Symbol)
        Assert.NotNull(special.GetSymbolInfo(projected).Symbol)
        for isSpecial in[]bool{specialFirst, !specialFirst} {
            let model = if isSpecial {
                special
            } else {
                normal
            }
            let context = TranslationContext(compilation, model, tree.FilePath)
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
            )
            Assert.Contains("return value!!.Length", printed)
            let callbacks = Assert.IsType[TranslationContext.DeferredCallbackIndex](context.EffectIndexes.DeferredIndex)
            Assert.NotEmpty(callbacks.Comparers)
            Assert.Equal(
                isSpecial,
                callbacks.Comparers.Any(
                    (
                        entry(
                            Syntax Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax,
                            Owner CSharpCompilation
                        )
                    ) ->
                    object.ReferenceEquals(entry.Syntax, factory)
                )
            )
            let projection = ProjectedBaseCompilationIndex.For(context.OwnershipIndexIdentity)
            Assert.True(projection.IsIndexed)
            Assert.NotEmpty(projection.MemberConsumersByCandidate)
            Assert.Equal(
                isSpecial,
                projection
                    .MemberConsumersByCandidate
                    .Values
                    .Any(
                    (entries List[(CSharpCompilation, SyntaxNode)]) -> entries.Any(
                        (entry(CSharpCompilation, SyntaxNode)) -> object.ReferenceEquals(entry.Item2, projected)
                    )
                )
            )
            if isSpecial {
                let other = compilation.WithAssemblyName("RelatedNormalModel5326")
                let otherModel = other.GetSemanticModel(tree)
                Assert.Null(otherModel.GetSymbolInfo(factory).Symbol)
                let related = context.CreateRelatedContext(other, otherModel, tree.FilePath)
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, otherModel), related)
                let relatedCallbacks = Assert.IsType[TranslationContext.DeferredCallbackIndex](
                    related.EffectIndexes.DeferredIndex
                )
                Assert.DoesNotContain(
                    relatedCallbacks.Comparers,
                    (
                        entry(
                            Syntax Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax,
                            Owner CSharpCompilation
                        )
                    ) ->
                    object.ReferenceEquals(entry.Syntax, factory)
                )
                let relatedProjection = ProjectedBaseCompilationIndex.For(related.OwnershipIndexIdentity)
                Assert.True(relatedProjection.IsIndexed)
                Assert.False(
                    relatedProjection
                        .MemberConsumersByCandidate
                        .Values
                        .Any(
                        (entries List[(CSharpCompilation, SyntaxNode)]) -> entries.Any(
                            (entry(CSharpCompilation, SyntaxNode)) -> object.ReferenceEquals(entry.Item2, projected)
                        )
                    )
                )
                Assert.Contains(
                    callbacks.Comparers,
                    (
                        entry(
                            Syntax Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax,
                            Owner CSharpCompilation
                        )
                    ) ->
                    object.ReferenceEquals(entry.Syntax, factory)
                )
            }
        }
    }

    @Theory
    @InlineData("values.Aggregate((left, right) => { global = null; return left; });", true)
    @InlineData("values.Where(value => { global = null; return true; });", false)
    func RefParameter_DeclaredEnumerableExecutionContractsPreserveClosedControls(statement string, immediate bool) {
        let printed = AssertRunsLikeCSharp(
            "using System; using System.Linq; using System.Collections.Generic; public static class Demo { private static string? global; private static int Guard(ref string? text, List<int> values) { if(text == null)return 0; _ = " +
                statement +
                " return text.Length; } public static string Run() { global = \"safe\"; try { return Guard(ref global, new List<int>{1,2}).ToString(); } catch(NullReferenceException) { return \"cleared\"; } } }"
        )
        Assert.Contains(
            if immediate {
                "return text!!.Length"
            } else {
                "return text.Length"
            },
            printed
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_ProjectedArrayHelperRetainsSelectedSharedTreeOwner(consumerSharesTree bool) {
        let shared = CSharpSyntaxTree.ParseText(
            "namespace Lib5617 { public class SharedArrayBase { public static string[] Get() { Helper.Touch(); return new[] {\"item\"}; } public static T[] GetGeneric<T>(T value) where T : class { Helper.Touch(); return new[] {value}; } } }",
            path: "SharedArray.cs"
        )
        let producerBody = CSharpSyntaxTree.ParseText(
            "namespace Lib5617 { internal static class Helper { public static void Touch() { Store.Value = null; } } public static class Store { public static string? Value; } public class ProducerBridge : SharedArrayBase {} }",
            path: "ProducerArray.cs"
        )
        let rootHelper = CSharpSyntaxTree.ParseText(
            "namespace Lib5617 { internal static class Helper { public static void Touch() {} } }",
            path: "ConsumerArrayHelper.cs"
        )
        let source = CSharpSyntaxTree.ParseText(
            "using System; using Lib5617; public class SourceLeaf : ProducerBridge {} public static class Demo { private static int Guard(ref string? text) { if(text == null)return 0; var items = SourceLeaf.Get(); var genericItems = SourceLeaf.GetGeneric(\"generic\"); return text.Length + items[0].Length + genericItems[0].Length; } public static string Run() { Store.Value = \"safe\"; try { return Guard(ref Store.Value).ToString(); } catch(NullReferenceException) { return \"cleared\"; } } }",
            path: "ConsumerArray.cs"
        )
        let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
            NullableContextOptions.Enable
        )
        let producer = CSharpCompilation.Create(
            "Lib5617",
            []SyntaxTree{shared, producerBody},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let other = CSharpCompilation.Create(
            "OtherArrayOwner5326",
            []SyntaxTree{shared, rootHelper},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let trees = if consumerSharesTree {
            []SyntaxTree{source, shared, rootHelper}
        } else {
            []SyntaxTree{source}
        }
        let references = CSharpProjectLoader.RuntimeReferences().Concat(
            []MetadataReference{
                producer.ToMetadataReference(),
                other.ToMetadataReference(aliases: ImmutableArray.Create("Unused"))
            }
        )
        let consumer = CSharpCompilation.Create("ArrayOwnerConsumer5326", trees, references, options)
        Assert.Empty(
            consumer.GetDiagnostics().Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
        )
        let document = LoadedDocument(source.FilePath, source, consumer.GetSemanticModel(source))
        let context = TranslationContext(consumer, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("return text!!.Length", printed)
        using let image = MemoryStream()
        let emitted = producer.Emit(image)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        Assert.Equal(
            Encoding.UTF8.GetBytes("cleared"),
            Encoding.UTF8.GetBytes(CompileAndRun(printed, image.ToArray()).Trim())
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefParameter_EnumerableReturningAggregateExecutesItsCallbackImmediately(inHelper bool) {
        let call = "_ = values.Aggregate((left, right) => { global = null; return left; });"
        let printed = AssertRunsLikeCSharp(`
using System;
using System.Linq;
using System.Collections.Generic;
public static class Demo {
    private static string? global;
    private static void Probe(List<IEnumerable<int>> values, Func<IEnumerable<int>,IEnumerable<int>,IEnumerable<int>> callback) { _ = values.Aggregate(callback); }
    private static int Guard(ref string? text, List<IEnumerable<int>> values) {
        if(text == null) return 0;
        ` + if inHelper {
                "Probe(values, (left, right) => { global = null; return left; });"
            } else {
                call
            } + `
        return text.Length;
    }
    public static string Run() {
        global = "safe";
        var values = new List<IEnumerable<int>> { new[] {1}, new[] {2} };
        try { return Guard(ref global, values).ToString(); }
        catch(NullReferenceException) { return "cleared"; }
    }
}`)
        Assert.Contains("return text!!.Length", printed)
    }

    @Fact
    func RefParameter_AdjacentGotoCase_KeepsThePrecedingSectionEffects() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Box { public int F; }
public class Demo
{
    public static int Read(ref string? s, Box box, int k)
    {
        if (s == null) return 0;
        switch (k)
        {
            case 0:
                box.F = 1;
                goto case 1;
            case 1:
                return s.Length;
            default:
                return 0;
        }
    }
    public static string Run()
    {
        string? text = "abc";
        return Read(ref text, new Box(), 0).ToString();
    }
}`)
        Assert.Contains("return s!!.Length", printed)
    }

    /// The issue shape: `Lazy<T>.Value` is an imported getter that is not on the stable list (R16).
    @Fact
    func RefParameter_ReadAfterAnUnlistedImportedGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System;
public class Demo
{
    public static int Compute(ref string? s, Lazy<int> lazy)
    {
        if (s == null) return 0;
        var n = lazy.Value;
        return s.Length + n;
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Lazy<int>(() => 1)).ToString();
    }
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// A source property with a computed getter runs user code (R14).
    @Fact
    func RefParameter_ReadAfterAComputedSourceGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Counter
{
    private int count;
    public int Next => ++count;
}
public class Demo
{
    public static int Compute(ref string? s, Counter counter)
    {
        if (s == null) return 0;
        var n = counter.Next;
        return s.Length + n;
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Counter()).ToString();
    }
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// An overridable auto property read through a receiver whose type can have a subclass can dispatch to an
    /// override with user code (R14, #5599).
    @Fact
    func OutParameter_ReadAfterAnOverridableAutoPropertyOfAnOpenReceiver_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public class Shape
{
    public virtual int Size { get; set; }
}
public class Square : Shape
{
    public Square() { Size = 5; }
    public override int Size { get; set; }
}
public class Demo
{
    static string? Pick() => "abc";
    public static int Compute(out string? s, Shape shape)
    {
        s = Pick();
        if (s == null) return 0;
        var n = shape.Size;
        return s.Length + n;
    }
    public static string Run() => Compute(out _, new Square()).ToString();
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// An imported indexer read that is not on the stable list (`Dictionary<K, V>` calls `GetHashCode` and `Equals`
    /// of the key) runs user code (R17).
    @Fact
    func RefParameter_ReadAfterAnUnlistedImportedIndexer_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public class Demo
{
    public static int Compute(ref string? s, Dictionary<int, int> map)
    {
        if (s == null) return 0;
        var n = map[1];
        return s.Length + n;
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Dictionary<int, int> { [1] = 7 }).ToString();
    }
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// An imported indexer write, an imported setter and a field write: a write through a member or an element can
    /// change the storage that a by-reference parameter names (R12, R17).
    @Fact
    func RefParameter_ReadAfterAnImportedSetterOrIndexerWrite_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
using System.IO;
public sealed class Box
{
    public int Field;
}
public class Demo
{
    public static int Store(ref string? s, Dictionary<int, int> table)
    {
        if (s == null) return 0;
        table[2] = 5;
        return s.Length + table.Count;
    }
    public static int Seek(ref string? s, MemoryStream stream)
    {
        if (s == null) return 0;
        stream.Position = 0;
        return s.Length;
    }
    public static int Write(ref string? s, Box box)
    {
        if (s == null) return 0;
        box.Field = 3;
        return s.Length + box.Field;
    }
    public static string Run()
    {
        string? text = "abc";
        return Store(ref text, new Dictionary<int, int>()) + "," + Seek(ref text, new MemoryStream()) + "," + Write(ref text, new Box());
    }
}`)
        Assert.Contains("return s!!.Length + table.Count", printed)
        Assert.Contains("return s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s!!.Length + box.Field", printed)
    }

    /// cs2gs lowers a positional subpattern to a read of the member that its slot deconstructs to, so a computed
    /// getter there runs user code (R14). A positional record property is a plain auto property and keeps the fact.
    @Fact
    func RefParameter_ReadAfterAPositionalPatternOverAComputedGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Counter
{
    private int count;
    public int Next => ++count;
    public void Deconstruct(out int next) { next = Next; }
}
public sealed record Point(int X);
public class Demo
{
    public static int Compute(ref string? s, Counter counter)
    {
        if (s == null) return 0;
        var hit = counter is Counter(1);
        return s.Length + (hit ? 1 : 0);
    }
    public static int Plain(ref string? s, Point point)
    {
        if (s == null) return 0;
        var hit = point is Point(1);
        return s.Length + (hit ? 1 : 0);
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Counter()) + "," + Plain(ref text, new Point(1));
    }
}`)
        Assert.Contains("return s!!.Length + (if hit", printed)
        Assert.Contains("return s.Length + (if hit", printed)
    }

    /// The guard's own pattern runs its getters before the fact holds, so gsc does not narrow a by-reference variable
    /// on a pattern with a computed getter (R18 (6)). A plain auto property keeps the fact.
    @Fact
    func RefParameter_GuardedByItsOwnPatternWithAComputedGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Box
{
    private int count;
    public int P => ++count;
    public int Q { get; set; }
    public int X = 7;
}
public class Demo
{
    public static int Compute(ref Box? s)
    {
        if (s is Box { P: 1 } matched) return s.X;
        return 0;
    }
    public static int Plain(ref Box? s)
    {
        if (s is Box { Q: 0 } matched) return s.X + 1;
        return 0;
    }
    public static string Run()
    {
        Box? box = new Box();
        return Compute(ref box) + "," + Plain(ref box);
    }
}`)
        Assert.Contains("return s!!.X\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s.X + 1", printed)
    }

    /// A writable `ref` local of an element can write the storage that a by-reference parameter names, so gsc records
    /// it as a write (R12, `RecordWritableReference`). A `ref readonly` local and a `ref` local of a local keep the fact.
    @Fact
    func RefParameter_ReadAfterAWritableRefLocalOfAnElement_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public class Demo
{
    public static int Writable(ref string? s, int[] xs)
    {
        if (s == null) return 0;
        ref int alias = ref xs[0];
        return s.Length + alias;
    }
    public static int ReadOnly(ref string? s, int[] xs)
    {
        if (s == null) return 0;
        ref readonly int view = ref xs[0];
        return s.Length + view + 1;
    }
    public static int OfLocal(ref string? s, int[] xs)
    {
        var n = xs[1];
        if (s == null) return 0;
        ref int local = ref n;
        return s.Length + local + 2;
    }
    public static string Run()
    {
        string? text = "abc";
        var xs = new int[] { 4, 5 };
        return Writable(ref text, xs) + "," + ReadOnly(ref text, xs) + "," + OfLocal(ref text, xs);
    }
}`)
        Assert.Contains("return s!!.Length + alias", printed)
        Assert.Contains("return s.Length + view + 1", printed)
        Assert.Contains("return s.Length + local + 2", printed)
    }

    /// gsc emits an index read on an imported `List<int>` subclass nested in `Outer<T>` through `IList`, because the
    /// CLR type arguments of the nested type include `T` (R17). The listed `List<T>` indexer is then not the one that
    /// runs. A closed `Outer<string>.Items` uses the listed indexer and keeps the fact.
    @Fact
    func RefParameter_ReadAfterAnIndexOfAnImportedNestedTypeOfAGenericParameter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using Lib;
public class Demo
{
    public static int Open<T>(ref string? s, Outer<T>.Items items)
    {
        if (s == null) return 0;
        var n = items[0];
        return s.Length + n;
    }
    public static int Closed(ref string? s, Outer<string>.Items items)
    {
        if (s == null) return 0;
        var n = items[0];
        return s.Length + n + 1;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new Outer<string>().Values;
        return Open<string>(ref text, items) + "," + Closed(ref text, items);
    }
}`, library: `
using System.Collections.Generic;
namespace Lib
{
    public class Outer<T>
    {
        public class Items : List<int> { }
        public Items Values { get; } = new Items { 4 };
    }
}`)
        Assert.Contains("return s!!.Length + n\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s.Length + n + 1", printed)
    }

    /// A `with` expression writes the members of the copy, which gsc counts as a member write (R12), for a positional
    /// property and for an `init` property.
    @Fact
    func RefParameter_ReadAfterARecordWithExpression_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed record Rec(int X)
{
    public int Y { get; init; }
}
public class Demo
{
    public static int Positional(ref string? s, Rec r)
    {
        if (s == null) return 0;
        var r2 = r with { X = 2 };
        return s.Length + r2.X;
    }
    public static int Init(ref string? s, Rec r)
    {
        if (s == null) return 0;
        var r2 = r with { Y = 3 };
        return s.Length + r2.Y;
    }
    public static string Run()
    {
        string? text = "abc";
        return Positional(ref text, new Rec(1)) + "," + Init(ref text, new Rec(1));
    }
}`)
        Assert.Contains("return s!!.Length + r2.X", printed)
        Assert.Contains("return s!!.Length + r2.Y", printed)
    }

    /// The address of a member names storage that a write through the pointer can change, so gsc counts it as a
    /// write (R12). The address of a local keeps the fact.
    @Fact
    func RefParameter_ReadAfterTheAddressOfAMember_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public struct Pt { public int X; }
public class Demo
{
    public static unsafe int Member(ref string? s, int seed)
    {
        var pt = new Pt { X = seed };
        if (s == null) return 0;
        int* p = &pt.X;
        return s.Length + *p;
    }
    public static unsafe int Local(ref string? s, int seed)
    {
        var n = seed;
        if (s == null) return 0;
        int* q = &n;
        return s.Length + *q + 1;
    }
    public static string Run()
    {
        string? text = "abc";
        return Member(ref text, 4) + "," + Local(ref text, 4);
    }
}`)
        Assert.Contains("return s!!.Length + *p", printed)
        Assert.Contains("return s.Length + *q + 1", printed)
    }

    /// cs2gs passes the receiver of a `this ref` extension as `&counters[0]`, a writable reference to an element,
    /// which gsc counts as a write (R12). A local receiver and an `in` receiver keep the fact.
    @Fact
    func RefParameter_ReadAfterARefExtensionCallOnAnElement_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public struct Counter { public int N; }
public static class Ext
{
    public static void Touch(this ref Counter value) { value.N++; }
    public static int Peek(this in Counter value) => value.N;
}
public class Demo
{
    public static int Element(ref string? s, Counter[] counters)
    {
        if (s == null) return 0;
        counters[0].Touch();
        return s.Length + counters[0].N;
    }
    public static int Local(ref string? s, int seed)
    {
        var c = new Counter { N = seed };
        if (s == null) return 0;
        c.Touch();
        return s.Length + c.N + 1;
    }
    public static int ReadOnly(ref string? s, Counter[] counters)
    {
        if (s == null) return 0;
        var n = counters[0].Peek();
        return s.Length + n + 2;
    }
    public static string Run()
    {
        string? text = "abc";
        var counters = new Counter[1];
        return Element(ref text, counters) + "," + Local(ref text, 1) + "," + ReadOnly(ref text, counters);
    }
}`)
        Assert.Contains("return s!!.Length + counters[0].N", printed)
        Assert.Contains("return s.Length + c.N + 1", printed)
        Assert.Contains("return s.Length + n + 2", printed)
    }

    /// A `switch` case or arm runs its test, and its guard, before its body (ADR-0208, #5629). cs2gs lowers a property
    /// case to a guard that reads the property, so a computed getter there removes the fact for the body. A constant
    /// case on `object` calls `Equals`, a plain call that keeps the fact of a by-reference variable (amendment A3).
    @Fact
    func RefParameter_ReadInASwitchCaseAfterAnAccessorTest_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System;
public sealed class Box { private int count; public int P => ++count; }
public class Demo
{
    public static int Case(ref string? s, object o)
    {
        if (s == null) return 0;
        switch (o)
        {
            case Box { P: 1 }:
                return s.Length;
            default:
                return 0;
        }
    }
    public static int Arm(ref string? s, object o)
    {
        if (s == null) return 0;
        return o switch { Box { P: 1 } => s.Length + 1, _ => 0 };
    }
    public static int Guard(ref string? s, int n, Lazy<int> lazy)
    {
        if (s == null) return 0;
        switch (n)
        {
            case 1 when lazy.Value > 0:
                return s.Length + 2;
            default:
                return 0;
        }
    }
    public static int Constant(ref string? s, object o)
    {
        if (s == null) return 0;
        switch (o)
        {
            case 1:
                return s.Length + 3;
            default:
                return 0;
        }
    }
    public static string Run()
    {
        string? text = "abc";
        return Case(ref text, new Box()) + "," + Arm(ref text, new Box()) + "," +
            Guard(ref text, 1, new Lazy<int>(() => 1)) + "," + Constant(ref text, 1);
    }
}`)
        Assert.Contains("return s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("s!!.Length + 1", printed)
        Assert.Contains("return s!!.Length + 2", printed)
        Assert.Contains("return s.Length + 3", printed)
    }

    /// A `default` section that is not last runs after the tests and guards of the later cases (#5629), so a later
    /// guard or property case with an accessor removes the fact for the `default` body. A later constant case on
    /// `int32` keeps it.
    @Fact
    func RefParameter_ReadInADefaultBeforeAnAccessorCase_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System;
public sealed class Box { private int count; public int P => ++count; }
public class Demo
{
    public static int Guard(ref string? s, int n, Lazy<int> lazy)
    {
        if (s == null) return 0;
        switch (n)
        {
            default:
                return s.Length;
            case 1 when lazy.Value > 0:
                return 0;
        }
    }
    public static int Property(ref string? s, object o)
    {
        if (s == null) return 0;
        switch (o)
        {
            default:
                return s.Length + 1;
            case Box { P: 1 }:
                return 0;
        }
    }
    public static int Constant(ref string? s, int n)
    {
        if (s == null) return 0;
        switch (n)
        {
            default:
                return s.Length + 2;
            case 1:
                return 0;
        }
    }
    public static string Run()
    {
        string? text = "abc";
        return Guard(ref text, 2, new Lazy<int>(() => 1)) + "," + Property(ref text, new Box()) + "," +
            Constant(ref text, 2);
    }
}`)
        Assert.Contains("return s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s!!.Length + 1", printed)
        Assert.Contains("return s.Length + 2", printed)
    }

    /// A field read, the getters and indexers on the stable list, a plain auto property, an overridable auto property
    /// through a receiver that cannot have a subclass, and `Nullable<T>.Value` (which the translator emits as `!!`)
    /// run no user code, so gsc keeps the fact and the read stays bare.
    @Fact
    func RefParameter_ReadAfterAccessorsThatRunNoUserCode_StaysBare() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
using System.Text;
public sealed class Box
{
    public int Field = 1;
}
public sealed class Person
{
    public string Name { get; init; } = "ab";
    public int Age { get; set; }
}
public class Shape
{
    public virtual int Size { get; set; }
}
public sealed class Square : Shape
{
    public Square() { Size = 5; }
    public override int Size { get; set; }
}
public class Demo
{
    public static int Compute(ref string? s, Box box, string other, List<int> list, Dictionary<int, int> table, StringBuilder builder)
    {
        if (s == null) return 0;
        var a = box.Field;
        var b = other.Length + other[0];
        var c = list.Count + list[0];
        var d = table.Count + builder.Length;
        return s.Length + a + b + c + d;
    }
    public static int Members(ref string? s, Person person, Square square, int? maybe)
    {
        if (s == null) return 0;
        var a = person.Name.Length + person.Age;
        var b = square.Size;
        var c = maybe.HasValue ? maybe.Value : 0;
        return s.Length + a + b + c;
    }
    public static string Run()
    {
        string? text = "abc";
        var list = new List<int> { 4 };
        var table = new Dictionary<int, int> { [1] = 1 };
        return Compute(ref text, new Box(), "xy", list, table, new StringBuilder("q")) + "," + Members(ref text, new Person(), new Square(), 3);
    }
}`)
        Assert.DoesNotContain("s!!", printed)
    }

    /// Issue #5650: gsc iterates every collection other than a single-dimensional array and a `string` through an
    /// enumerator, which can run user code (ADR-0208 R11), so the fact ends at the loop: inside the body and after it.
    /// This holds for an `in` and an `out` parameter as for a `ref` parameter.
    @Fact
    func RefParameter_ReadAfterOrInAForEachOverAnEnumerable_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public class Demo
{
    static IEnumerable<int> Numbers() { yield return 1; yield return 2; }
    public static int Compute(ref string? s, List<int> items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item;
        return s.Length + total;
    }
    public static int Inside(ref string? s, List<int> items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item + s.Length;
        return total;
    }
    public static int Sequence(in string? s, IEnumerable<int> items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item;
        return s.Length + total;
    }
    public static int Map(out string? s, Dictionary<int, int> items)
    {
        s = items.Count > 0 ? "abcd" : null;
        if (s == null) return 0;
        var total = 0;
        foreach (var pair in items) total += pair.Value;
        return s.Length + total;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new List<int> { 1, 2 };
        return Compute(ref text, items) + "," + Inside(ref text, items) + "," + Sequence(in text, Numbers()) + "," +
            Map(out _, new Dictionary<int, int> { [1] = 5 });
    }
}`)
        Assert.Contains("return s!!.Length + total", printed)
        Assert.Contains("total += item + s!!.Length", printed)
        Assert.Equal(4, Regex.Matches(printed, `s!!`).Count)
    }

    /// A span, an immutable array and a multi-dimensional array are pattern enumerators in gsc (ADR-0208 R11).
    @Fact
    func RefParameter_ReadAfterOrInAForEachOverAPatternEnumerator_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System;
using System.Collections.Immutable;
public class Demo
{
    public static int Spans(ref string? s, Span<int> items, ReadOnlySpan<int> readOnly)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item + s.Length;
        foreach (var item in readOnly) total += item;
        return s.Length + total;
    }
    public static int Immutable(ref string? s, ImmutableArray<int> items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item + s.Length;
        return total;
    }
    public static int Grid(ref string? s, int[,] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item + s.Length;
        return s.Length + total;
    }
    public static string Run()
    {
        string? text = "abc";
        return Spans(ref text, new[] { 1, 2 }.AsSpan(), new[] { 3 }) + "," +
            Immutable(ref text, ImmutableArray.Create(4, 5)) + "," + Grid(ref text, new int[2, 2]);
    }
}`)
        Assert.Equal(5, Regex.Matches(printed, `s!!`).Count)
    }

    /// gsc iterates a single-dimensional array and a `string` by index, which runs no user code, also with a typed
    /// loop variable that widens, wraps or boxes the element, with an inferred tuple-target loop and a record into
    /// discards only, which reads no member (ADR-0213 table T5). A loop that holds a
    /// `while` loop, and not a `for ... in`, keeps the fact too. The reads stay bare.
    @Fact
    func RefParameter_ReadAfterAForEachOverAnArrayOrAString_StaysBare() {
        let printed = AssertRunsLikeCSharp(`
using System.Text;
public record Point(int X, int Y);
public sealed class Wrapper
{
    public int V;
    public static implicit operator Wrapper(int v) => new Wrapper { V = v };
}
public class Demo
{
    public static int Arrays(ref string? s, int[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item + s.Length;
        foreach (var item in items) total += item;
        return s.Length + total;
    }
    public static int Strings(ref string? s, string text, StringBuilder builder)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var c in text) total += 1 + s.Length;
        foreach (var c in builder.ToString()) total += 1;
        foreach (var part in "a,b".Split(',')) total += 1;
        return s.Length + total;
    }
    public static int Typed(ref string? s, int[] items, (int, int)[] pairs, Point[] points)
    {
        if (s == null) return 0;
        long sum = 0;
        var n = 0;
        foreach (long item in items) sum += item;
        foreach (int? item in items) n += 1;
        foreach (object item in items) n += 1;
        foreach (var (a, b) in pairs) n += s.Length;
        foreach (var (_, _) in points) n += 1;
        foreach ((Wrapper _, int _) in points) n += 1;
        return s.Length + n + (int)sum;
    }
    public static int InnerWhile(ref string? s, int[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items)
        {
            var m = 0;
            while (m < 2) { total += item; m++; }
        }
        return s.Length + total;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new[] { 1, 2 };
        return Arrays(ref text, items) + "," + Strings(ref text, "xy", new StringBuilder("q")) + "," +
            Typed(ref text, items, new[] { (1, 2) }, new[] { new Point(3, 4) }) + "," + InnerWhile(ref text, items);
    }
}`)
        Assert.DoesNotContain("s!!", printed)
    }

    /// The loop variable's prelude runs before every body run (ADR-0213 table T5): a `Deconstruct` of a record, a
    /// user-defined conversion of a typed loop variable, a tuple conversion (rebuilt element by element) and the
    /// unwrapping of a nullable value run code, so the fact ends even over an array.
    @Fact
    func RefParameter_ReadAfterAForEachWhosePreludeRunsUserCode_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public record Point(int X, int Y);
public sealed class Wrapper
{
    public int V;
    public static implicit operator Wrapper(int v) => new Wrapper { V = v };
}
public class Demo
{
    public static int Records(ref string? s, Point[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (x, y) in items) total += s.Length;
        return s.Length + total;
    }
    public static int FirstOfRecords(ref string? s, Point[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (x, _) in items) total += 1;
        return s.Length + total;
    }
    public static int Pairs(ref string? s, Dictionary<int, int> items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (k, v) in items) total += v;
        return s.Length + total;
    }
    public static int Converted(ref string? s, int[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (Wrapper w in items) total += w.V;
        return s.Length + total;
    }
    public static int Tuples(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach ((long, long) pair in items) total += s.Length + 1;
        return s.Length + total;
    }
    public static int Unwrapped(ref string? s, int?[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (int item in items) total += item;
        return s.Length + total;
    }
    public static string Run()
    {
        string? text = "abc";
        return Records(ref text, new[] { new Point(1, 2) }) + "," + FirstOfRecords(ref text, new[] { new Point(5, 6) }) +
            "," + Pairs(ref text, new Dictionary<int, int> { [1] = 2 }) + "," + Converted(ref text, new[] { 7 }) + "," +
            Tuples(ref text, new[] { (1, 2) }) + "," + Unwrapped(ref text, new int?[] { 3 });
    }
}`)
        Assert.Contains("total += s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("total += s!!.Length + 1", printed)
        Assert.Equal(8, Regex.Matches(printed, `s!!`).Count)
    }

    /// gsc scans a loop's region without types, so a `for ... in` nested in a loop counts as an iteration that runs
    /// user code for the enclosing loop, whatever its collection (ADR-0213 section 9). The fact ends at the entry of
    /// the enclosing loop and stays removed after it. A guard inside the enclosing loop is after that entry, so only
    /// the inner loop counts for its reads. A `do ... while (false)` has no back edge, so gsc does not apply its region
    /// (`HeaderIsLiteralFalse`).
    @Fact
    func RefParameter_ReadAroundALoopThatHoldsAForEach_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public sealed class Box
{
    public int F;
}
public class Demo
{
    public static int NestedArrays(ref string? s, int[] outer, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var o in outer)
        {
            total += s.Length;
            foreach (var i in inner) total += i;
        }
        return s.Length + total;
    }
    public static int WhileLoop(ref string? s, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        var n = 0;
        while (n < 2)
        {
            total += s.Length;
            foreach (var i in inner) total += i;
            n++;
        }
        return total;
    }
    public static int ForLoop(ref string? s, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        for (var n = 0; n < 2; n++)
        {
            foreach (var i in inner) total += i;
        }
        return s.Length + total;
    }
    public static int DoLoop(ref string? s, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        var n = 0;
        do
        {
            foreach (var i in inner) total += i;
            n++;
        } while (n < 2);
        return s.Length + total;
    }
    public static int DoOnce(ref string? s, int[] inner, Box box)
    {
        if (s == null) return 0;
        var total = 0;
        do
        {
            total += s.Length + 3;
            box.F = 1;
            foreach (var i in inner) total += i;
        } while (false);
        return s.Length + total;
    }
    public static int DoOnceThenRead(ref string? s, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        do
        {
            foreach (var i in inner) total += i;
        } while (false);
        return total + s.Length;
    }
    public static int GuardInLoopOverArrays(ref string? s, int[] outer, int[] inner)
    {
        var total = 0;
        foreach (var o in outer)
        {
            if (s == null) continue;
            foreach (var i in inner) total += i;
            total += s.Length + 1;
        }
        return total;
    }
    public static int GuardInLoopOverList(ref string? s, int[] outer, List<int> inner)
    {
        var total = 0;
        foreach (var o in outer)
        {
            if (s == null) continue;
            foreach (var i in inner) total += i;
            total += s.Length + 2;
        }
        return total;
    }
    public static string Run()
    {
        string? text = "abc";
        var inner = new[] { 2 };
        return NestedArrays(ref text, new[] { 1 }, inner) + "," + WhileLoop(ref text, inner) + "," +
            ForLoop(ref text, inner) + "," + DoLoop(ref text, inner) + "," + DoOnce(ref text, inner, new Box()) + "," +
            DoOnceThenRead(ref text, inner) + "," +
            GuardInLoopOverArrays(ref text, new[] { 1 }, inner) + "," +
            GuardInLoopOverList(ref text, new[] { 1 }, new List<int> { 2 });
    }
}`)
        Assert.Contains("total += s.Length + 1", printed)
        Assert.Contains("total += s!!.Length + 2", printed)
        Assert.Contains("total += s.Length + 3", printed)
        Assert.Contains("return total + s.Length", printed)
        Assert.Equal(7, Regex.Matches(printed, `s!!`).Count)
    }

    /// gsc binds the `else` branch of an `if` from the state before the `then` branch (#5650, #5654), so a loop or a
    /// field write in the `then` branch leaves a read in the `else` branch bare.
    /// ADR-0208 R4 also isolates switch section bodies when no goto can enter another section.
    @Fact
    func RefParameter_ReadInAnElseAfterALoopInTheThenBranch_StaysBare() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public sealed class Box
{
    public int F;
}
public class Demo
{
    public static int Loop(ref string? s, List<int> items, bool flag)
    {
        if (s == null) return 0;
        var total = 0;
        if (flag)
        {
            foreach (var item in items) total += item;
        }
        else if (total == 0)
        {
            return s.Length + 1;
        }
        else
        {
            return s.Length + 2;
        }
        return total;
    }
    public static int Write(ref string? s, Box box, bool flag)
    {
        if (s == null) return 0;
        if (flag)
        {
            box.F = 1;
        }
        else
        {
            return s.Length + 3;
        }
        return box.F;
    }
    public static int Section(ref string? s, List<int> items, int k)
    {
        if (s == null) return 0;
        var total = 0;
        switch (k)
        {
            case 1:
                foreach (var item in items) total += item;
                break;
            default:
                return s.Length + 4;
        }
        return total;
    }
    public static int ForwardGotoExit(ref string? s, Box box, bool flag)
    {
        if (s == null) return 0;
        if (flag)
        {
            box.F = 1;
            goto Done;
        }
        else
        {
        Unused:
            return s.Length + 5;
        }
    Done:
        return box.F;
    }
    public static int ForwardGotoInThen(ref string? s, Box box, bool flag)
    {
        if (s == null) return 0;
        if (flag)
        {
            box.F = 1;
            goto Step;
        Step:
            return 1;
        }
        else
        {
            return s.Length + 7;
        }
    }
    public static int BackwardGotoInThen(ref string? s, Box box, bool flag, bool step)
    {
        if (s == null) return 0;
        if (flag)
        {
        Loop:
            box.F = 1;
            if (step)
            {
                step = false;
                goto Loop;
            }
        }
        else
        {
            return s.Length + 8;
        }
        return box.F;
    }
    public static int MergedBackwardGotoSpan(ref string? s, Box box, bool flag, bool a, bool b)
    {
        if (s == null) return 0;
    L1:
        if (a)
        {
            a = false;
            goto L1;
        }
        if (flag)
        {
            box.F = 1;
        }
        else
        {
            return s.Length + 9;
        }
    L2:
        if (b)
        {
            b = false;
            goto L2;
        }
        return box.F;
    }
    public static int LoweredGotoCase(ref string? s, Box box, bool flag, int k)
    {
        if (s == null) return 0;
        switch (k)
        {
            case 0:
                break;
            default:
                goto case 0;
        }
        if (flag)
        {
            box.F = 1;
        }
        else
        {
            return s.Length + 10;
        }
        switch (k)
        {
            case 0:
                break;
            default:
                goto case 0;
        }
        return box.F;
    }
    public static int DefaultFirstSection(ref string? s, Box box, int k)
    {
        if (s == null) return 0;
        switch (k)
        {
            default:
                box.F = 1;
                break;
            case 1:
                return s.Length + 6;
        }
        return box.F;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new List<int> { 1 };
        return Loop(ref text, items, false) + "," + Loop(ref text, items, true) + "," +
            Write(ref text, new Box(), false) + "," + Section(ref text, items, 2) + "," +
            ForwardGotoExit(ref text, new Box(), false) + "," + ForwardGotoInThen(ref text, new Box(), false) + "," +
            BackwardGotoInThen(ref text, new Box(), false, false) + "," +
            MergedBackwardGotoSpan(ref text, new Box(), false, false, false) + "," +
            LoweredGotoCase(ref text, new Box(), false, 1) + "," +
            DefaultFirstSection(ref text, new Box(), 1);
    }
}`)
        Assert.Contains("return s.Length + 1", printed)
        Assert.Contains("return s.Length + 2", printed)
        Assert.Contains("return s.Length + 3", printed)
        Assert.Contains("return s.Length + 4", printed)
        Assert.Contains("return s.Length + 5", printed)
        Assert.Contains("return s.Length + 6", printed)
        Assert.Contains("return s.Length + 7", printed)
        Assert.Contains("return s.Length + 8", printed)
        Assert.Contains("return s!!.Length + 9", printed)
        Assert.Contains("return s.Length + 10", printed)
    }

    /// The collection of a `for ... in` and the initializer of a `for` run once, before the loop's region, so effects
    /// in the loop do not reach a read in them (ADR-0213 table T5). A collection read in a loop that is nested in
    /// another loop is in the enclosing loop's region.
    @Fact
    func RefParameter_ReadInALoopCollectionOrInitializer_IsAssertedOnlyInAnEnclosingLoop() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public sealed class Box
{
    public int F;
}
public class Demo
{
    static List<int> Make(int n) => new List<int> { n, 2 };
    public static int Collection(ref string? s, Box box)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in Make(s.Length)) { total += item; box.F = item; }
        return total;
    }
    public static int Initializer(ref string? s, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        for (var n = s.Length; n < 5; n++)
        {
            foreach (var i in inner) total += i;
        }
        return total;
    }
    public static int Nested(ref string? s, int[] outer)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var o in outer)
        {
            foreach (var item in Make(s.Length + 1)) total += item;
        }
        return total;
    }
    public static string Run()
    {
        string? text = "abc";
        return Collection(ref text, new Box()) + "," + Initializer(ref text, new[] { 2 }) + "," +
            Nested(ref text, new[] { 1 });
    }
}`)
        Assert.Contains("Make(s.Length)", printed)
        Assert.Contains("Make(s!!.Length + 1)", printed)
        Assert.Equal(1, Regex.Matches(printed, `s!!`).Count)
    }

    /// Issue #5692 (1): a numeric conversion in a loop that cs2gs emits as `T(x)` counts as a construction call in
    /// gsc's region scanner (`CallIsIndirect`), which removes a by-reference fact at loop entry and after the loop.
    /// Outside a loop, or after a guard inside the same loop body, the fact stays.
    @Fact
    func RefParameter_ReadAroundALoopWithAConversionCall_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public class Base { public int V = 1; }
public sealed class Derived : Base { }
public partial class Demo
{
    static partial void ElidedTrace(long n);
    public static void TakeUint(uint value) { }
    public static int ForEachCharToInt(ref string? s, string text)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var c in text) total += c;
        return s.Length + total;
    }
    public static long WhileIntToLong(ref string? s)
    {
        if (s == null) return 0;
        long total = 0;
        var i = 0;
        while (i < 2)
        {
            total += s.Length;
            i++;
        }
        return total + s.Length;
    }
    public static int ArrayLengthLongToInt(ref string? s, long n)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            var buf = new byte[n];
            total += buf.Length;
            i++;
        }
        return s.Length + total;
    }
    public static int CovariantArrayInLoop(ref string? s, string[] strings)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            object[] copy = strings;
            total += copy.Length;
            i++;
        }
        return s.Length + total + 2;
    }
    public static int CoalesceAssignCovariantArrayInLoop(ref string? s, string[] strings)
    {
        if (s == null) return 0;
        object[]? copy = null;
        var i = 0;
        while (i < 1)
        {
            copy ??= strings;
            i++;
        }
        return s.Length + copy!.Length + 3;
    }
    static void Touch<T>() { }
    public static int BareGenericStaticCallInLoop(ref string? s)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            Touch<int>();
            i++;
        }
        return s.Length + 4;
    }
    public static int ConditionalReferenceUpcastInLoop(ref string? s, Derived d, Base b, bool flag)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            var picked = flag ? d : b;
            total += picked.V;
            i++;
        }
        return s.Length + total + 5;
    }
    public static int SwitchReferenceUpcastInLoop(ref string? s, Derived d, Base b, int k)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            var picked = k switch { 0 => d, _ => b };
            total += picked.V;
            i++;
        }
        return s.Length + total + 6;
    }
    public static int CollectionElementConversionInLoop(ref string? s)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            byte[] bytes = [1];
            total += bytes.Length;
            i++;
        }
        return s.Length + total + 8;
    }
    public static int RelationalPatternConversionInLoop(ref string? s, byte b)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            if (b is > 1) total++;
            if (b is 2) total++;
            i++;
        }
        return s.Length + total + 9;
    }
    public static int CoalesceAssignNumericInLoop(ref string? s)
    {
        if (s == null) return 0;
        long? n = null;
        var i = 0;
        while (i < 1)
        {
            n ??= 1;
            i++;
        }
        return n == null ? 0 : s.Length + 10;
    }
    public static uint UnsignedReturnControl(ref string? s, bool exitEarly)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            if (exitEarly) return 0;
            i++;
        }
        return (uint)s.Length;
    }
    public static int ElidedPartialAndUnsignedLiteralControls(ref string? s, byte b)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            ElidedTrace((long)i);
            Demo.TakeUint(5);
            switch (b)
            {
                case > 1:
                    break;
            }
            i++;
        }
        return s.Length + 7;
    }
    public static int GuardInsideLoop(ref string? s, string text)
    {
        var total = 0;
        foreach (var c in text)
        {
            if (s == null) continue;
            total += c;
            total += s.Length + 1;
        }
        return total;
    }
    public static long OutsideLoop(ref string? s, int n)
    {
        if (s == null) return 0;
        long wide = (long)n;
        return s.Length + wide;
    }
    public static string Run()
    {
        string? text = "abc";
        return ForEachCharToInt(ref text, "xy") + "," + WhileIntToLong(ref text) + "," +
            ArrayLengthLongToInt(ref text, 2L) + "," + CovariantArrayInLoop(ref text, new[] { "a" }) + "," +
            CoalesceAssignCovariantArrayInLoop(ref text, new[] { "b" }) + "," +
            BareGenericStaticCallInLoop(ref text) + "," +
            ConditionalReferenceUpcastInLoop(ref text, new Derived(), new Base(), true) + "," +
            SwitchReferenceUpcastInLoop(ref text, new Derived(), new Base(), 0) + "," +
            CollectionElementConversionInLoop(ref text) + "," +
            RelationalPatternConversionInLoop(ref text, 3) + "," +
            CoalesceAssignNumericInLoop(ref text) + "," +
            UnsignedReturnControl(ref text, false) + "," +
            ElidedPartialAndUnsignedLiteralControls(ref text, 3) + "," +
            GuardInsideLoop(ref text, "z") + "," + OutsideLoop(ref text, 4);
    }
}`)
        Assert.Contains("return s!!.Length + total\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("total += int64(s!!.Length)", printed)
        Assert.Contains("return total + int64(s!!.Length)", printed)
        Assert.Contains("[int32(n)]uint8", printed)
        Assert.Contains("cast[[]object](strings)", printed)
        Assert.Contains("return s!!.Length + total + 2", printed)
        Assert.Contains("return s!!.Length + copy!!.Length + 3", printed)
        Assert.Contains("return s!!.Length + 4", printed)
        Assert.Contains("return s!!.Length + total + 5", printed)
        Assert.Contains("return s!!.Length + total + 6", printed)
        Assert.Contains("return s!!.Length + total + 8", printed)
        Assert.Contains("return s!!.Length + total + 9", printed)
        Assert.Contains("s!!.Length + 10", printed)
        Assert.Contains("return uint32(s.Length)", printed)
        Assert.Contains("return s.Length + 7", printed)
        Assert.Contains("total += s.Length + 1", printed)
        Assert.Contains("return int64(s.Length) + wide", printed)
    }

    /// Issue #5692 (2): gsc's region scanner gives no origin to the variables of a deconstructing `for (a, b) in items`
    /// loop, so using a deconstructed variable (or an inferred copy or pattern-bound alias of it) in the body removes
    /// a by-reference fact at loop entry and after it. Unused deconstructed variables, an unused `var` or same-typed
    /// copy, a dropped `_ = a` discard statement, and a pure type test keep the fact.
    @Fact
    func RefParameter_ReadAroundAForEachThatUsesADeconstructedLoopVariable_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public class Demo
{
    public static int AfterLoop(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items) total += a + b;
        return s.Length + total;
    }
    public static int InsideLoop(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items) total += a + s.Length;
        return total;
    }
    public static int UsedThroughCopy(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items)
        {
            var copy = a;
            total += copy;
        }
        return s.Length + total + 2;
    }
    public static int UsedThroughPatternAlias(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items)
        {
            if (a is var copy) total += copy;
        }
        return s.Length + total + 5;
    }
    public static int UsedThroughTupleCopy(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items)
        {
            var pair = (a, b);
            total += pair.a;
        }
        return s.Length + total + 6;
    }
    public static int UnusedVariables(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items) total += s.Length + 1;
        return s.Length + total;
    }
    static void Touch(ref int value) { }
    public static int UnusedCopyOnly(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        foreach (var (a, b) in items)
        {
            _ = a;
            var copy = a;
            _ = copy;
            Demo.Touch(ref copy);
            var unusedPair = (a, b);
            _ = unusedPair;
            int typedCopy = b;
            if (b is var unusedAlias)
            {
                _ = unusedAlias;
            }
            for (var i = 0; i < 1; i++, _ = a)
            {
            }
        }
        return s.Length + 3;
    }
    public static int PureTypeTestOnly(ref string? s, (object, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items)
        {
            if (a is string) total += 1;
        }
        return s.Length + total + 4;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new[] { (1, 2) };
        return AfterLoop(ref text, items) + "," + InsideLoop(ref text, items) + "," +
            UsedThroughCopy(ref text, items) + "," + UsedThroughPatternAlias(ref text, items) + "," +
            UsedThroughTupleCopy(ref text, items) + "," +
            UnusedVariables(ref text, items) + "," + UnusedCopyOnly(ref text, items) + "," +
            PureTypeTestOnly(ref text, new (object, int)[] { ("x", 1) });
    }
}`)
        Assert.Contains("return s!!.Length + total\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("total += a + s!!.Length", printed)
        Assert.Contains("return s!!.Length + total + 2", printed)
        Assert.Contains("return s!!.Length + total + 5", printed)
        Assert.Contains("return s!!.Length + total + 6", printed)
        Assert.Contains("total += s.Length + 1", printed)
        Assert.Contains("return s.Length + 3", printed)
        Assert.Contains("return s.Length + total + 4", printed)
        Assert.Equal(5, Regex.Matches(printed, `s!!`).Count)
    }

    /// Issue #5692 (3): gsc's region scanner cannot resolve the element origin of an untyped `for x in call()` loop
    /// when an extension method of that name can bind (`"a,b".Split(',')` or a source extension on `ShadowedBox`),
    /// when a source generic type's method returns `T[]` (`GenericBox<int>.GetItems()`), when type arguments are
    /// emitted on the call (`box.Collide(new Unrelated())`), or when the call is an unqualified static class method
    /// (`Parts()`), so reading a member of `x` in the body counts as a read on an untyped receiver (W5) and removes a
    /// by-reference fact. Over a parameter slice `parts`, a qualified static call `Box.Parts()` or
    /// `QualifiedNs.StaticHolder.MakeSeed()`, an instance member call `box.InstanceParts()` or inferred generic
    /// `box.InstanceParts(1)` or chained `box.Self().InstanceParts(1)`, a source extension `word.WordParts()` or
    /// `values.Entries()`, or a pure string concatenation, the fact stays.
    @Theory
    @InlineData("SourceClear();", true)
    @InlineData("values.Clear();", true)
    @InlineData("cancellation.Cancel();", true)
    @InlineData("Invoke(callback);", true)
    @InlineData("Library.NoOp();", true)
    @InlineData("if (Library.Check() && s.Length > 0) { total++; }", true)
    @InlineData("for (int i = 0; i < 2; i++) { total += s.Length; SourceClear(); }", true)
    @InlineData("for (int i = 0; i < 2; i++) { total += s.Length; values.Clear(); }", true)
    @InlineData("for (int i = 0; i < 2; i++) { total += s.Length; cancellation.Cancel(); }", true)
    @InlineData("Pure(); integers.Clear();", false)
    @InlineData("Invoke(() => { });", false)
    @InlineData("var deferred = new[] { 1 }.Where(_ => { global = null; return true; });", false)
    func RefParameter_UsesStorageEffectsAcrossCallsAndConditions(statement string, asserted bool) {
        let printed = AssertRunsLikeCSharp(`
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using CallEffectLibrary;
public static class Demo {
    private static string? global = "global";
    private static ref string? Slot() => ref global;
    private static void SourceClear() { global = null; }
    private static void Pure() { }
    private static void Invoke(Action callback) { callback(); }
    private static int Guard(ref string? s, List<string?> values, List<int> integers, CancellationTokenSource cancellation, Action callback) {
        if (s == null) return 0;
        int total = 0;
        ` + statement + `
        return s.Length + total + 11;
    }
    public static string Run() {
        string? value = "safe";
        using var cancellation = new CancellationTokenSource();
        cancellation.Token.Register(() => { global = null; });
        return Guard(ref value, new List<string?> { "item" }, new List<int> { 1 }, cancellation, () => { global = null; }).ToString();
    }
}`, library: `namespace CallEffectLibrary;
public static class Library {
    public static void NoOp() { }
    public static bool Check() => true;
}`)
        Assert.Contains(
            if asserted {
                "return s!!.Length + total + 11"
            } else {
                "return s.Length + total + 11"
            },
            printed
        )
    }

    @Theory
    @InlineData("ClearCells();", "cells[0].Text")
    @InlineData("ResetBox();", "box.Text")
    @InlineData("explicitTarget.Touch();", "global")
    @InlineData("genericTarget.Touch(1);", "global")
    @InlineData("ReadProperty();", "global")
    @InlineData("ReadIndexer();", "global")
    @InlineData("Format(new Formatter());", "global")
    @InlineData("FormatHandler();", "HandlerStore.Value")
    @InlineData("Recurse(() => { }, 1);", "global")
    @InlineData("Construct();", "global")
    @InlineData("disposable.Dispose();", "global")
    @InlineData("ReverseBuffer();", "buffer[0]")
    @InlineData("_ = sequence.Count();", "global")
    @InlineData("_ = dictionary.ContainsKey(1);", "global")
    func RefParameter_TransitiveOperationEffects(statement string, root string) {
        let printed = AssertRunsLikeCSharp(`
using System;
using System.Linq;
using System.Collections.Generic;
using EffectCells;
public interface IExplicit { void Touch(); }
public interface IGenericExplicit<T> { void Touch(T value); }
public sealed class ExplicitWriter : IExplicit {
    void IExplicit.Touch() { Demo.ClearGlobal(); }
}
public sealed class GenericExplicitWriter<T> : IGenericExplicit<T> {
    void IGenericExplicit<T>.Touch(T value) { Demo.ClearGlobal(); }
}
public sealed class Disposer : IDisposable {
    public void Dispose() { Demo.ClearGlobal(); }
}
public sealed class Formatter {
    public override string ToString() { Demo.ClearGlobal(); return "formatted"; }
}
public class Base {
    private int initialized = Demo.ClearAndReturn();
}
public sealed class Derived : Base { }
public sealed class Indexer {
    public int this[int index] { get { Demo.ClearGlobal(); return index; } }
}
public sealed class KeyComparer : IEqualityComparer<int> {
    public bool Equals(int x, int y) => x == y;
    public int GetHashCode(int value) { Demo.ClearGlobal(); return value; }
}
public static class Demo {
    private static string? global;
    private static Cell box;
    private static Cell[] cells = new Cell[1];
    private static string?[] buffer = new string?[2];
    public static void ClearGlobal() { global = null; }
    public static int ClearAndReturn() { ClearGlobal(); return 1; }
    private static int P { get { ClearGlobal(); return 1; } }
    private static void ReadProperty() { _ = P; }
    private static void ReadIndexer() { _ = new Indexer()[0]; }
    private static void Format(Formatter value) { _ = $"{value}"; }
    private static void FormatHandler() { HandlerStore.Format($"{1}"); }
    private static void Clear<T>(T[] items) where T : struct { items[0] = default; }
    private static void ClearCells() { Clear(cells); }
    private static void ReverseBuffer() { System.MemoryExtensions.Reverse<string?>(buffer.AsSpan()); }
    private static void ResetBox() { box = default; }
    private static void Construct() { _ = new Derived(); }
    private static void Recurse(Action callback, int remaining) {
        if (remaining > 0) Recurse(() => ClearGlobal(), remaining - 1);
        else callback();
    }
    private static int Guard(ref string? s, IExplicit explicitTarget, IGenericExplicit<int> genericTarget, IDisposable disposable,
        IEnumerable<int> sequence, Dictionary<int, int> dictionary) {
        if (s == null) return 0;
        ` + statement + `
        return s.Length + 19;
    }
    public static string Run() {
        var dictionary = new Dictionary<int, int>(new KeyComparer());
        dictionary.Add(1, 2);
        global = "safe"; box.Text = "safe"; cells[0].Text = "safe"; HandlerStore.Value = "safe";
        buffer[0] = "safe"; buffer[1] = null;
        var sequence = new[] { 1 }.Where(x => { ClearGlobal(); return true; });
        try { return Guard(ref ` + root + `, new ExplicitWriter(), new GenericExplicitWriter<int>(), new Disposer(), sequence, dictionary).ToString(); }
        catch (NullReferenceException) { return "cleared"; }
    }
}`, library: `
namespace EffectCells;
public struct Cell { public string? Text; }
public static class HandlerStore {
    public static string? Value;
    public static void Format(EffectHandler handler) { }
}
[System.Runtime.CompilerServices.InterpolatedStringHandler]
public ref struct EffectHandler {
    public EffectHandler(int literalLength, int formattedCount) { HandlerStore.Value = null; }
    public void AppendLiteral(string text) { }
    public void AppendFormatted(int value) { }
}`)
        Assert.Contains("return s!!.Length + 19", printed)
    }

    @Theory
    @InlineData(12)
    @InlineData(35)
    func RefParameter_SharedCalleeAnalysisIsLinear(depth int32) {
        let source = StringBuilder("public static class Demo { private static void M0() { }")
        for var i = 1; i <= depth; i++ {
            source
                .Append("private static void M")
                .Append(i)
                .Append("() { M")
                .Append(i - 1)
                .Append("(); M")
                .Append(i - 1)
                .Append("(); }")
        }
        source
            .Append("private static int Guard(ref string? s) { if (s == null) return 0; M")
            .Append(depth)
            .Append("(); return s.Length; } public static string Run() => \"analysis\"; }")
        var visits = 0
        let printed = AssertRunsLikeCSharp(
            source.ToString(),
            inspect: (context TranslationContext) -> {
                visits = context.StorageEffectBodyVisits
            }
        )
        Assert.Contains("return s.Length", printed)
        Assert.InRange(visits, depth + 1, (depth + 1) * 3)
    }

    @Theory
    @InlineData(
        "private static event Action Changed { add { global = null; } remove { global = null; } } private static void Handler() {} private static void Probe() { Changed += Handler; }",
        "global"
    )
    @InlineData("private static int count; private static void Probe() { (global, count) = (null, 0); }", "global")
    @InlineData(
        "private sealed class Initialized { public int P { get; } = Clear(); public Initialized() {} } private static int Clear() { global = null; return 1; } private static void Probe() { _ = new Initialized(); }",
        "global"
    )
    @InlineData(
        "private static void Probe() { _ = new List<int>(new[] { 1 }.Where(x => { global = null; return true; })); }",
        "global"
    )
    @InlineData("private static void Probe() { Array.Clear(items, 0, items.Length); }", "items[0]")
    @InlineData(
        "private static readonly Dictionary<int,int> dictionary = new Dictionary<int,int>(EqualityComparer<int>.Create((x,y) => x == y, x => { global = null; return x; })); private static void Probe() { _ = dictionary.ContainsKey(1); }",
        "global"
    )
    func RefParameter_ImplicitOperationEdges(members string, root string) {
        let printed = AssertRunsLikeCSharp(`
using System;
using System.Collections.Generic;
using System.Linq;
public static class Demo {
    private static string? global;
    private static string?[] items = new string?[1];
    ` + members + `
    private static int Guard(ref string? value) {
        if (value == null) return 0;
        Probe();
        return value.Length + 31;
    }
    public static string Run() {
        global = "safe"; items[0] = "safe";
        try { return Guard(ref ` + root + `).ToString(); }
        catch (NullReferenceException) { return "cleared"; }
    }
}`)
        Assert.Contains("return value!!.Length + 31", printed)
    }

    @Theory
    @InlineData(
        "private static IEnumerable<object> Create() { global = null; yield return 1; }",
        "_ = pending.Count();"
    )
    @InlineData(
        "private sealed class Key { public override int GetHashCode() { global = null; return 1; } } private static IEnumerable<object> Create() => new[] { new Key() }.Distinct();",
        "_ = pending.Count();"
    )
    @InlineData(
        "private sealed class Key { public override int GetHashCode() { global = null; return 1; } } private static IEnumerable<object> Create() => new[] { new Key() };",
        "_ = new Dictionary<object,int>(pending.Select(x => new KeyValuePair<object,int>(x, 1)));"
    )
    func RefParameter_StoredSequencesExecuteCallbacksAtEnumeration(members string, consume string) {
        let printed = AssertRunsLikeCSharp(`
using System;
using System.Linq;
using System.Collections.Generic;
public static class Demo {
    private static string? global;
    ` + members + `
    private static int Guard(ref string? value, IEnumerable<object> pending) {
        if (value == null) return 0;
        ` + consume + `
        return value.Length + 37;
    }
    public static string Run() {
        var pending = Create();
        global = "safe";
        try { return Guard(ref global, pending).ToString(); }
        catch (NullReferenceException) { return "cleared"; }
    }
}`)
        Assert.Contains("return value!!.Length + 37", printed)
    }

    @Fact
    func RefParameter_MoreThan128PureCallbackContextsRemainPure() {
        let statements = string.Concat(Enumerable.Repeat("Invoke(() => { });", 160))
        let printed = AssertRunsLikeCSharp(`
public static class Demo {
    private static void Invoke(System.Action action) { action(); }
    private static int Guard(ref string? value) {
        if (value == null) return 0;
        ` + statements + `
        return value.Length;
    }
    public static string Run() { string? text = "safe"; return Guard(ref text).ToString(); }
}`)
        Assert.Contains("return value.Length", printed)
        Assert.DoesNotContain("value!!", printed)
    }

    @Theory
    @InlineData("disposable.Dispose();")
    @InlineData("_ = $\"{formatted}\";")
    @InlineData("_ = $\"{(formatted, 1)}\";")
    func RefParameter_UntrustedRuntimeImplementationsRemainUnknown(statement string) {
        let printed = AssertRunsLikeCSharp(`
using System;
using ExternalEffects;
public static class Demo {
    private static void Probe(IDisposable disposable, Formatted formatted) { ` + statement + ` }
    private static int Guard(ref string? value, IDisposable disposable, Formatted formatted) {
        if (value == null) return 0;
        Probe(disposable, formatted);
        return value.Length + 41;
    }
    public static string Run() {
        var disposable = new Disposer(); var formatted = new Formatted(); Store.Value = "safe";
        try { return Guard(ref Store.Value, disposable, formatted).ToString(); }
        catch (NullReferenceException) { return "cleared"; }
    }
}`, library: `
namespace ExternalEffects;
public static class Store { public static string? Value; }
public sealed class Disposer : System.IDisposable { public void Dispose() { Store.Value = null; } }
public sealed class Formatted { public override string ToString() { Store.Value = null; return "formatted"; } }
`)
        Assert.Contains("return value!!.Length + 41", printed)
    }

    @Theory
    @InlineData("_ = $\"{formatted}\";")
    @InlineData("for (var i = 0; i < 1; i++) { _ = $\"{formatted}\"; }")
    @InlineData("_ = values.Count();")
    @InlineData("_ = dictionary.ContainsKey(1);")
    @InlineData("_ = keys.Contains(key);")
    func RefParameter_CallbackImplementationsAreNotLimitedToSourceMethods(statement string) {
        let printed = AssertRunsLikeCSharp(`
using System;
using System.Linq;
using System.Collections.Generic;
using ExternalEffects;
public static class Demo {
    private sealed class Formatter { public override string ToString() { Store.Value = null; return "formatted"; } }
    private static int Guard(ref string? value, Formatter formatted, IEnumerable<int> values,
        Dictionary<int,int> dictionary, List<Key> keys, Key key) {
        if (value == null) return 0;
        ` + statement + `
        return value.Length + 43;
    }
    public static string Run() {
        var formatted = new Formatter(); var values = Factory.Sequence();
        var dictionary = Factory.Dictionary(); var key = new Key(); var keys = new List<Key> { key };
        Store.Value = "safe";
        try { return Guard(ref Store.Value, formatted, values, dictionary, keys, key).ToString(); }
        catch (NullReferenceException) { return "cleared"; }
    }
}`, library: `
using System;
using System.Collections;
using System.Collections.Generic;
namespace ExternalEffects;
public static class Store { public static string? Value; }
public sealed class Key {
    public override bool Equals(object? other) { Store.Value = null; return true; }
    public override int GetHashCode() => 1;
}
public static class Factory {
    private sealed class Comparer<T> : IEqualityComparer<T> {
        public bool Equals(T? x, T? y) => EqualityComparer<T>.Default.Equals(x, y);
        public int GetHashCode(T x) { Store.Value = null; return x!.GetHashCode(); }
    }
    private sealed class SequenceValue : IEnumerable<int> {
        public IEnumerator<int> GetEnumerator() { Store.Value = null; return ((IEnumerable<int>)new[] { 1 }).GetEnumerator(); }
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
    public static IEnumerable<int> Sequence() => new SequenceValue();
    public static Dictionary<int,int> Dictionary() => new Dictionary<int,int>(new Comparer<int>()) { [1] = 1 };
}
`)
        Assert.Contains("return value!!.Length + 43", printed)
    }

    @Theory
    @InlineData(
        "private static void Clear() { System.Collections.Generic.IEnumerable<int> Local() { yield return 1; } global = null; }",
        "Clear();"
    )
    @InlineData("private static void Clear() { global = null; }", "_ = System.Linq.Enumerable.Pretend();")
    func RefParameter_DeferredProofRequiresOwnYieldAndVerifiedFramework(members string, statement string) {
        let printed = AssertRunsLikeCSharp(`
using System;
using System.Collections.Generic;
namespace System.Linq {
    public static class Enumerable {
        public static IEnumerable<int> Pretend() { Demo.ClearForFactory(); return Array.Empty<int>(); }
    }
}
public static class Demo {
    private static string? global;
    public static void ClearForFactory() { global = null; }
    ` + members + `
    private static int Guard(ref string? value) {
        if (value == null) return 0;
        ` + statement + `
        return value.Length + 47;
    }
    public static string Run() {
        global = "safe";
        try { return Guard(ref global).ToString(); }
        catch (NullReferenceException) { return "cleared"; }
    }
}`)
        Assert.Contains("return value!!.Length + 47", printed)
    }

    @Theory
    @InlineData("_ = token + token;", true)
    @InlineData("for (var i = 0; i < 1; i++) { _ = token + token; }", true)
    @InlineData("int converted = token;", true)
    @InlineData("_ = $\"{leaf}\";", true)
    @InlineData("_ = $\"{wrapped}\";", true)
    @InlineData("_ = dictionary.ContainsKey(1);", true)
    @InlineData("_ = values.Count();", true)
    @InlineData("_ = ownedList.Count();", false)
    @InlineData("_ = ownedDictionary.ContainsKey(1);", false)
    @InlineData("_ = $\"{ownedRecord}\";", false)
    @InlineData("stream.CopyTo(Stream.Null);", true)
    @InlineData("_ = property.GetValue(getter);", true)
    func RefParameter_ActualCallbackTargetsAndOperandProvenance(statement string, asserted bool) {
        let printed = AssertRunsLikeCSharp(`
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Collections.Generic;
using ExternalEffects;
public static class Demo {
    private struct Token {
        public static Token operator +(Token x, Token y) { Store.Value = null; return x; }
        public static implicit operator int(Token x) { Store.Value = null; return 1; }
    }
    private sealed class Leaf : Base { }
    private sealed record Wrapper(Noisy Value);
    private sealed record CleanWrapper(int Value);
    private sealed class Noisy { public override string ToString() { Store.Value = null; return "noisy"; } }
    private static int Guard(ref string? value, Token token, Leaf leaf, Wrapper wrapped,
        Dictionary<int,int> dictionary, List<int> values, Stream stream, PropertyInfo property, Getter getter) {
        var ownedList = new List<int> { 1 };
        var ownedDictionary = new Dictionary<int,int>();
        var ownedRecord = new CleanWrapper(1);
        if (value == null) return 0;
        ` + statement + `
        return value.Length + 53;
    }
    public static string Run() {
        var leaf = new Leaf(); var wrapped = new Wrapper(new Noisy()); var dictionary = new Dictionary<int,int>();
        var values = Factory.Values(); var stream = Factory.Stream(); var getter = new Getter();
        var property = typeof(Getter).GetProperty("Value")!;
        Store.Value = "safe";
        try { return Guard(ref Store.Value, default, leaf, wrapped, dictionary, values, stream, property, getter).ToString(); }
        catch (NullReferenceException) { return "cleared"; }
    }
}`, library: `
using System;
using System.IO;
using System.Collections.Generic;
namespace ExternalEffects;
public static class Store { public static string? Value; }
public class Base { public override string ToString() { Store.Value = null; return "base"; } }
public sealed class Getter { public int Value { get { Store.Value = null; return 1; } } }
public static class Factory {
    private sealed class ValuesList : List<int>, ICollection<int> {
        int ICollection<int>.Count { get { Store.Value = null; return 1; } }
    }
    private sealed class ForwardingStream : MemoryStream {
        public override void CopyTo(Stream destination, int bufferSize) { Store.Value = null; }
    }
    public static List<int> Values() => new ValuesList();
    public static Stream Stream() => new ForwardingStream();
}
`)
        Assert.True(
            printed.Contains(
                if asserted {
                    "return value!!.Length + 53"
                } else {
                    "return value.Length + 53"
                },
                StringComparison.Ordinal
            ),
            printed
        )
    }

    @Fact
    func RefParameter_ComparerFromAnUnreferencedCallerCannotEstablishPurity() {
        let printed = AssertRunsLikeCSharp(`
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Collections.Generic;
public static class Demo {
    private static string? global;
    public static int Guard(ref string? value, Dictionary<int,int> dictionary) {
        if (value == null) return 0;
        _ = dictionary.ContainsKey(1);
        return value.Length;
    }
    public static string Run() {
        var caller = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(x => x.GetName().Name == "HiddenCaller5326")
            ?? Assembly.LoadFrom(Path.Combine(AppContext.BaseDirectory, "HiddenCaller5326.dll"));
        var dictionary = (Dictionary<int,int>)caller.GetType("Caller")!.GetMethod("Create")!
            .Invoke(null, new object[] { (Action)(() => global = null) })!;
        global = "safe";
        try { return Guard(ref global, dictionary).ToString(); }
        catch (NullReferenceException) { return "cleared"; }
    }
}`, library: `
using System;
using System.Collections.Generic;
public static class Caller {
    private sealed class Comparer : IEqualityComparer<int> {
        private readonly Action clear;
        public Comparer(Action clear) { this.clear = clear; }
        public bool Equals(int x, int y) => x == y;
        public int GetHashCode(int x) { clear(); return x; }
    }
    public static Dictionary<int,int> Create(Action clear) => new Dictionary<int,int>(new Comparer(clear)) { [1] = 1 };
}`, runtimeOnlyLibrary: true, inspect: (
                context TranslationContext
            ) -> {
                Assert
                    .DoesNotContain(
                    context.Compilation.References,
                    (reference MetadataReference) ->
                    context.Compilation.GetAssemblyOrModuleSymbol(reference)?.Name == "HiddenCaller5326"
                )
            })
        Assert.Contains("return value!!.Length", printed)
    }

    @Fact
    func RefParameter_CanceledStorageTraversalDoesNotPublishASummary() {
        using let cancellation = CancellationTokenSource()
        cancellation.Cancel()
        Assert.Throws[OperationCanceledException](() -> AssertRunsLikeCSharp(`
public static class Demo {
    private static void Probe() { }
    private static int Guard(ref string? s) { if (s == null) return 0; Probe(); return s.Length; }
    public static string Run() => "analysis";
}`, cancellationToken: cancellation.Token))
    }

    @Fact
    func RefParameter_BoundImageDoesNotInheritItsSuppliedPathTrust() {
        let host = typeof(Console).Assembly.GetName()
        let source = "[assembly: System.Reflection.AssemblyVersion(\"" + host.Version!!.ToString() +
            "\")] namespace System { public static class EffectStore { public static string? Value; " +
            "public static void Clear() { Value = null; } } }"
        let library = CSharpCompilation.Create(
            host.Name,
            []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithCryptoPublicKey(host.GetPublicKey().ToImmutableArray())
                .WithPublicSign(true)
        )
        using let stream = MemoryStream()
        let emitted = library.Emit(stream)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let reference = MetadataReference.CreateFromImage(stream.ToArray(), filePath: typeof(Console).Assembly.Location)
        let references = CSharpProjectLoader
            .RuntimeReferences()
            .Where((item MetadataReference) -> (item as PortableExecutableReference)?.FilePath != reference.FilePath)
            .Append(cast[MetadataReference](reference))
        let tree = CSharpSyntaxTree.ParseText(`
public static class Demo {
    private static int Guard(ref string? s) {
        if (s == null) return 0;
        System.EffectStore.Clear();
        return s.Length;
    }
}
`)
        let compilation = CSharpCompilation.Create(
            "BoundImage5326",
            []SyntaxTree{tree},
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
        Assert.Empty(
            compilation.GetDiagnostics().Where(
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
        )
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument("Snippet.cs", tree, model)
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                document,
                TranslationContext(compilation, model, document.FilePath)
            )
        )
        Assert.Contains("return s!!.Length", printed)
    }

    @Fact
    func RefParameter_OwnedImageStaysFrozenAfterItsPathChanges() {
        let directory = Path.Combine(AppContext.BaseDirectory, "FrozenEffect5326", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let path = Path.Combine(directory, "System.Console.dll")
            File.Copy(typeof(Console).Assembly.Location, path)
            let reference = TranslationContext.CreateOwnedMetadataReference(path)
            let references = CSharpProjectLoader
                .RuntimeReferences()
                .Where(
                (item MetadataReference) -> (item as PortableExecutableReference)?.FilePath != typeof(Console)
                    .Assembly
                    .Location
            )
                .Append(cast[MetadataReference](reference))
            let tree = CSharpSyntaxTree.ParseText(`
public static class Demo {
    private static int Guard(ref string? s) {
        if (s == null) return 0;
        System.Console.WriteLine("pure");
        return s.Length;
    }
}`)
            let compilation = CSharpCompilation.Create(
                "FrozenImage5326",
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            Assert.NotNull(compilation.GetAssemblyOrModuleSymbol(reference))
            File.WriteAllBytes(path, []byte{0})
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(
                    document,
                    TranslationContext(compilation, model, document.FilePath)
                )
            )
            Assert.Contains("return s.Length", printed)
            Assert.DoesNotContain("s!!", printed)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func RefParameter_CallbackSummaryKeysIncludeActualSyntaxTreeIdentity() {
        let pure = CSharpSyntaxTree.ParseText(
            "public static class Pure { public static void Go() { Sink.Invoke(() => Act()); } private static void Act() { } }"
        )
        let evil = CSharpSyntaxTree.ParseText(
            "public static class Evil { public static void Go() { Sink.Invoke(() => Act()); } private static void Act() { Demo.Global = null; } }"
        )
        let tree = CSharpSyntaxTree.ParseText(`
public static class Sink { public static void Invoke(System.Action action) { action(); } }
public static class Demo {
    public static string? Global;
    private static int Safe(ref string? s) { if (s == null) return 0; Pure.Go(); return s.Length + 1; }
    private static int Write(ref string? s) { if (s == null) return 0; Evil.Go(); return s.Length + 2; }
}`)
        let compilation = CSharpCompilation.Create(
            "TreeIdentity5326",
            []SyntaxTree{tree, pure, evil},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
        Assert.Empty(
            compilation.GetDiagnostics().Where(
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
        )
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument("Snippet.cs", tree, model)
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                document,
                TranslationContext(compilation, model, document.FilePath)
            )
        )
        Assert.Contains("return s.Length + 1", printed)
        Assert.Contains("return s!!.Length + 2", printed)
    }

    @Fact
    func RefParameter_ReferencedSourceProjectAndCrossTreeCallbackUseOwningModels() {
        let producerTrees = []SyntaxTree{
            CSharpSyntaxTree.ParseText(
                "using System; using System.Linq; public static partial class Producer { public static string? Value; public static void Probe(Func<int,bool> predicate) { _ = new[] {1}.Where(predicate).Count(); } }",
                path: "Producer.cs"
            ),
            CSharpSyntaxTree.ParseText(
                "public static partial class Producer { public static void Clear() { Value = null; } }",
                path: "Producer.Clear.cs"
            )
        }
        let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
            NullableContextOptions.Enable
        )
        let producer = CSharpCompilation.Create(
            "Producer5326",
            producerTrees,
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let consumerTrees = []SyntaxTree{
            CSharpSyntaxTree.ParseText(
                "using System; public static partial class Demo { private static int Guard(ref string? value) { if(value == null) return 0; Producer.Probe(Predicate); return value.Length; } public static string Run() { Producer.Value = \"safe\"; try { return Guard(ref Producer.Value).ToString(); } catch(NullReferenceException) { return \"cleared\"; } } }",
                path: "Consumer.cs"
            ),
            CSharpSyntaxTree.ParseText(
                "public static partial class Demo { private static bool Predicate(int item) { Producer.Clear(); return true; } }",
                path: "Consumer.Callback.cs"
            )
        }
        let consumer = CSharpCompilation.Create(
            "Consumer5326",
            consumerTrees,
            CSharpProjectLoader.RuntimeReferences().Append(cast[MetadataReference](producer.ToMetadataReference())),
            options
        )
        Assert.Empty(
            consumer.GetDiagnostics().Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
        )
        var expected string? = nil
        let native = AssemblyLoadContext("SourceOwner5326", isCollectible: true)
        try {
            for compilation in[]CSharpCompilation{producer, consumer} {
                using let image = MemoryStream()
                let emitted = compilation.Emit(image)
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
                image.Position = 0
                let assembly = native.LoadFromStream(image)
                if object.ReferenceEquals(compilation, consumer) {
                    expected = cast[string](assembly.GetType("Demo", true)!!.GetMethod("Run")!!.Invoke(nil, nil))
                }
            }
        } finally {
            native.Unload()
        }
        Assert.Equal("cleared", expected)
        let texts = List[string]()
        for compilation in[]CSharpCompilation{consumer, producer} {
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                let document = LoadedDocument(tree.FilePath, tree, model)
                texts.Add(
                    GSharpPrinter.Print(
                        CSharpToGSharpTranslator().TranslateDocument(
                            document,
                            TranslationContext(compilation, model, document.FilePath)
                        )
                    )
                )
            }
        }
        Assert.Contains("return value!!.Length", texts[0])
        let lines = texts.SelectMany((text string) -> text.Split('\n')).ToArray()
        let imports = lines.Where((line string) -> line.StartsWith("import ", StringComparison.Ordinal)).Distinct()
        let bodies = lines.Where((line string) -> !line.StartsWith("import ", StringComparison.Ordinal))
        Assert.Equal(expected, CompileAndRun(string.Join("\n", imports.Concat(bodies)), Array.Empty[byte]()).Trim())
    }

    @Fact
    func RefParameter_ActualReferenceGraphOwnsProducerDefinedStorageWithSeparateSibling() {
        let producerTree = CSharpSyntaxTree.ParseText(
            "public sealed class Payload { public int Value => 1; } public static class Producer { public static Payload? Slot; public static void Clear() { Slot = null; } }",
            path: "Producer.Payload.cs"
        )
        let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
            NullableContextOptions.Enable
        )
        let producer = CSharpCompilation.Create(
            "PayloadProducer5326",
            []SyntaxTree{producerTree},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let sibling = CSharpCompilation.Create(
            "PayloadProducer5326",
            []SyntaxTree{producerTree},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let consumerTree = CSharpSyntaxTree.ParseText(
            "using System; public static class Demo { private static int Guard(ref Payload? value) { if(value == null)return 0; Producer.Clear(); return value.Value; } public static string Run() { Producer.Slot = new Payload(); try { return Guard(ref Producer.Slot).ToString(); } catch(NullReferenceException) { return \"cleared\"; } } }",
            path: "Consumer.Payload.cs"
        )
        let consumer = CSharpCompilation.Create(
            "PayloadConsumer5326",
            []SyntaxTree{consumerTree},
            CSharpProjectLoader.RuntimeReferences().Append(cast[MetadataReference](producer.ToMetadataReference())),
            options
        )
        let model = consumer.GetSemanticModel(consumerTree)
        let context = TranslationContext(
            consumer,
            model,
            consumerTree.FilePath,
            siblingCompilations: []CSharpCompilation{sibling}
        )
        Assert.Same(producer, context.GetOwnedSemanticModel(producerTree).Compilation)
        let consumerText = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                LoadedDocument(consumerTree.FilePath, consumerTree, model),
                context
            )
        )
        let producerText = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                LoadedDocument(producerTree.FilePath, producerTree, producer.GetSemanticModel(producerTree)),
                TranslationContext(producer, producer.GetSemanticModel(producerTree), producerTree.FilePath)
            )
        )
        Assert.Contains("return value!!.Value", consumerText)
        let lines = (consumerText + "\n" + producerText).Split('\n')
        let imports = lines.Where((line string) -> line.StartsWith("import ", StringComparison.Ordinal)).Distinct()
        let bodies = lines.Where((line string) -> !line.StartsWith("import ", StringComparison.Ordinal))
        Assert.Equal("cleared", CompileAndRun(string.Join("\n", imports.Concat(bodies)), Array.Empty[byte]()).Trim())
    }

    @Fact
    func RefParameter_SharedSyntaxTreeUsesTheSelectedProducerMethodOwner() {
        let shared = CSharpSyntaxTree.ParseText(
            "namespace Lib5617 { public static class SharedBody { public static void Probe() { Helper.Touch(); } } }",
            path: "Shared.cs"
        )
        let producerTree = CSharpSyntaxTree.ParseText(
            "namespace Lib5617 { internal static class Helper { public static void Touch() { Producer.Value = null; } } public static class Producer { public static string? Value; public static void Probe() { SharedBody.Probe(); } } }",
            path: "Producer.cs"
        )
        let helperTree = CSharpSyntaxTree.ParseText(
            "namespace Lib5617 { internal static class Helper { public static void Touch() {} } }",
            path: "ConsumerHelper.cs"
        )
        let consumerTree = CSharpSyntaxTree.ParseText(
            "using System; using Lib5617; public static class Demo { private static int Guard(ref string? value) { if(value == null)return 0; Producer.Probe(); return value.Length; } public static string Run() { Producer.Value = \"safe\"; try { return Guard(ref Producer.Value).ToString(); } catch(NullReferenceException) { return \"cleared\"; } } }",
            path: "Consumer.cs"
        )
        let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
            NullableContextOptions.Enable
        )
        let producer = CSharpCompilation.Create(
            "Lib5617",
            []SyntaxTree{shared, producerTree},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let consumer = CSharpCompilation.Create(
            "ConsumerShared5326",
            []SyntaxTree{shared, helperTree, consumerTree},
            CSharpProjectLoader.RuntimeReferences().Append(cast[MetadataReference](producer.ToMetadataReference())),
            options
        )
        Assert.Empty(
            consumer.GetDiagnostics().Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
        )
        let model = consumer.GetSemanticModel(consumerTree)
        let document = LoadedDocument(consumerTree.FilePath, consumerTree, model)
        let context = TranslationContext(consumer, model, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("return value!!.Length", printed)
        using let producerImage = MemoryStream()
        let emitted = producer.Emit(producerImage)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        Assert.Equal("cleared", CompileAndRun(printed, producerImage.ToArray()).Trim())
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func RefParameter_SharedTreeCallbackRetainsItsCallerCompilation(callbackClears bool) {
        let shared = CSharpSyntaxTree.ParseText(
            "using System; namespace Lib5617 { public static class SharedCallback { public static void Invoke(Action action) { action(); } public static void Callback() { Helper.Touch(); } } }",
            path: "SharedCallback.cs"
        )
        let producerTree = CSharpSyntaxTree.ParseText(
            "using System; namespace Lib5617 { internal static class Helper { public static void Touch() {} } public static class Producer { public static string? Value; public static void Invoke(Action action) { SharedCallback.Invoke(action); } } }",
            path: "Producer.cs"
        )
        let clear = if callbackClears {
            "Producer.Value = null;"
        } else {
            ""
        }
        let helperTree = CSharpSyntaxTree.ParseText(
            "namespace Lib5617 { internal static class Helper { public static void Touch() { $clear } } }",
            path: "CallerHelper.cs"
        )
        let consumerTree = CSharpSyntaxTree.ParseText(
            "using System; using Lib5617; public static class Demo { private static int Guard(ref string? value) { if(value == null)return 0; Producer.Invoke(SharedCallback.Callback); return value.Length; } public static string Run() { Producer.Value = \"safe\"; try { return Guard(ref Producer.Value).ToString(); } catch(NullReferenceException) { return \"cleared\"; } } }",
            path: "Caller.cs"
        )
        let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
            NullableContextOptions.Enable
        )
        let producer = CSharpCompilation.Create(
            "Lib5617",
            []SyntaxTree{shared, producerTree},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let consumer = CSharpCompilation.Create(
            "CallbackOwners5326",
            []SyntaxTree{shared, helperTree, consumerTree},
            CSharpProjectLoader.RuntimeReferences().Append(cast[MetadataReference](producer.ToMetadataReference())),
            options
        )
        Assert.Empty(
            consumer.GetDiagnostics().Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
        )
        let model = consumer.GetSemanticModel(consumerTree)
        let document = LoadedDocument(consumerTree.FilePath, consumerTree, model)
        let context = TranslationContext(consumer, model, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            if callbackClears {
                "return value!!.Length"
            } else {
                "return value.Length"
            },
            printed
        )
    }

    @Fact
    func RefParameter_CancelledSemanticBatchDoesNotPublishLinkedStorage() {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                (
                    "CancelledSemanticBatch.cs",
                    "public static class Demo { private static void Clear(ref string value) { value = null; } public static string Run() { var items = new[] {\"safe\"}; Clear(ref items[0]); return items[0] ?? \"-\"; } }"
                )
            }
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let catalog = List[CSharpCompilation]{project.Compilation}
        using let cancellation = CancellationTokenSource()
        let cancelled = TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            catalog,
            catalog,
            cancellation.Token
        )
        var reached = false
        cancelled.BeforeRefStoragePublication = func () {
            reached = true
            cancellation.Cancel()
        }
        Assert.ThrowsAny[OperationCanceledException](
            func () {
                let _ = CSharpToGSharpTranslator().TranslateDocument(document, cancelled)
            }
        )
        Assert.True(reached)
        var rebuilt = false
        let retry = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath, catalog, catalog)
        retry.BeforeRefStoragePublication = func () {
            rebuilt = true
        }
        let output = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, retry))
        Assert.True(rebuilt)
        Assert.Contains("[]string?", output)
        let peer = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath, catalog, catalog)
        Assert.Equal(
            Encoding.UTF8.GetBytes(output),
            Encoding.UTF8.GetBytes(GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, peer)))
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes("-"),
            Encoding.UTF8.GetBytes(CompileAndRun(output, Array.Empty[byte](), strictIl: true).Trim())
        )
    }

    @Fact
    func RefParameter_CatalogEpochIsolatesLinkedRefArrayPromotionsAcrossExistingContexts() {
        let shared = CSharpSyntaxTree.ParseText(
            "public static class Demo { public static string[] Values = new[] {\"safe\"}; internal static void Keep(ref string value) {} public static string Run() { Keep(ref Values[0]); return Values[0] ?? \"-\"; } }",
            path: "SharedArrayEpoch.cs"
        )
        let first = CSharpCompilation.Create(
            "LinkedEpochFirst5326",
            []SyntaxTree{shared},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let caller = CSharpSyntaxTree.ParseText(
            "internal static class Caller { private static void Clear(ref string value) { value = null; } internal static void Touch() { Clear(ref Demo.Values[0]); } }",
            path: "NullableEpochCaller.cs"
        )
        let second = CSharpCompilation.Create(
            "LinkedEpochSecond5326",
            []SyntaxTree{shared, caller},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let catalog = List[CSharpCompilation]{first}
        let model = first.GetSemanticModel(shared)
        let old = TranslationContext(first, model, shared.FilePath, catalog, catalog)
        let document = LoadedDocument(shared.FilePath, shared, model)
        let translator = CSharpToGSharpTranslator()
        let before = GSharpPrinter.Print(translator.TranslateDocument(document, old))
        Assert.Contains("Values []string", before)
        Assert.DoesNotContain("Values []string?", before)
        catalog.Add(second)
        let added = TranslationContext(first, model, shared.FilePath, catalog, catalog)
        let widened = GSharpPrinter.Print(translator.TranslateDocument(document, added))
        Assert.Contains("Values []string?", widened)
        let oldAfterAdd = GSharpPrinter.Print(translator.TranslateDocument(document, old))
        Assert.Equal(Encoding.UTF8.GetBytes(before), Encoding.UTF8.GetBytes(oldAfterAdd))
        catalog.Remove(second)
        let removed = TranslationContext(first, model, shared.FilePath, catalog, catalog)
        let afterRemove = GSharpPrinter.Print(translator.TranslateDocument(document, removed))
        Assert.Equal(Encoding.UTF8.GetBytes(before), Encoding.UTF8.GetBytes(afterRemove))
        let computations = ObliviousNullabilityAnalyzer.ComputeCount(first)
        for var index = 0; index < 16; index++ {
            let peer = TranslationContext(first, model, shared.FilePath, catalog, catalog)
            Assert.Same(removed.CatalogIdentity, peer.CatalogIdentity)
            Assert.Equal(
                Encoding.UTF8.GetBytes(afterRemove),
                Encoding.UTF8.GetBytes(GSharpPrinter.Print(translator.TranslateDocument(document, peer)))
            )
        }
        Assert.Equal(computations, ObliviousNullabilityAnalyzer.ComputeCount(first))
        Assert.Equal(
            Encoding.UTF8.GetBytes(widened),
            Encoding.UTF8.GetBytes(GSharpPrinter.Print(translator.TranslateDocument(document, added)))
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes("safe"),
            Encoding.UTF8.GetBytes(CompileAndRun(before, Array.Empty[byte](), strictIl: true).Trim())
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes("safe"),
            Encoding.UTF8.GetBytes(CompileAndRun(widened, Array.Empty[byte](), strictIl: true).Trim())
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes("safe"),
            Encoding.UTF8.GetBytes(CompileAndRun(afterRemove, Array.Empty[byte](), strictIl: true).Trim())
        )
    }

    @Fact
    func RefParameter_CatalogEpochIsolatesReferencedObliviousTupleContracts() {
        let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        let producer = CSharpCompilation.Create(
            "Lib5617",
            []SyntaxTree{
                CSharpSyntaxTree.ParseText(
                    "namespace Lib5617 { public static class Contract { public static void Keep(ref (string First, string Second) pair) { pair = (null, \"safe\"); } } }",
                    path: "TupleEpochProducer.cs"
                )
            },
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        using let image = MemoryStream()
        let emitted = producer.Emit(image)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let tree = CSharpSyntaxTree.ParseText(
            "using Lib5617; public static class Demo { private static void Forward(ref (string First, string Second) pair) { Contract.Keep(ref pair); } public static string Run() { var pair = (First: \"safe\", Second: \"safe\"); Forward(ref pair); return pair.First ?? \"-\"; } }",
            path: "TupleEpochConsumer.cs"
        )
        let root = CSharpCompilation.Create(
            "TupleEpochConsumer5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences().Append(
                cast[MetadataReference](MetadataReference.CreateFromImage(image.ToArray()))
            ),
            options
        )
        let method = root.GetTypeByMetadataName("Demo")!!
            .GetMembers("Forward")
            .OfType[IMethodSymbol]()
            .Single()
            .Parameters[0]
        let catalog = List[CSharpCompilation]{root}
        let model = root.GetSemanticModel(tree)
        let old = TranslationContext(root, model, tree.FilePath, catalog, catalog)
        let beforeTainted = ObliviousNullabilityAnalyzer.IsTupleElementTainted(
            root,
            method,
            []int32{0},
            old.RepositoryCompilations
        )
        let document = LoadedDocument(tree.FilePath, tree, model)
        let translator = CSharpToGSharpTranslator()
        let before = GSharpPrinter.Print(translator.TranslateDocument(document, old))
        catalog.Add(producer)
        let added = TranslationContext(root, model, tree.FilePath, catalog, catalog)
        let addedTainted = ObliviousNullabilityAnalyzer.IsTupleElementTainted(
            root,
            method,
            []int32{0},
            added.RepositoryCompilations
        )
        let addedOutput = GSharpPrinter.Print(translator.TranslateDocument(document, added))
        Assert.False(beforeTainted)
        Assert.True(addedTainted)
        Assert.False(
            ObliviousNullabilityAnalyzer.IsTupleElementTainted(root, method, []int32{0}, old.RepositoryCompilations)
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes(before),
            Encoding.UTF8.GetBytes(GSharpPrinter.Print(translator.TranslateDocument(document, old)))
        )
        catalog.Remove(producer)
        let removed = TranslationContext(root, model, tree.FilePath, catalog, catalog)
        Assert.False(
            ObliviousNullabilityAnalyzer.IsTupleElementTainted(root, method, []int32{0}, removed.RepositoryCompilations)
        )
        let removedOutput = GSharpPrinter.Print(translator.TranslateDocument(document, removed))
        Assert.Equal(Encoding.UTF8.GetBytes(before), Encoding.UTF8.GetBytes(removedOutput))
        let independent = root.WithAssemblyName("IndependentTupleEpoch5326")
        let otherModel = independent.GetSemanticModel(tree)
        let other = TranslationContext(independent, otherModel, tree.FilePath)
        let otherMethod = independent.GetTypeByMetadataName("Demo")!!
            .GetMembers("Forward")
            .OfType[IMethodSymbol]()
            .Single()
            .Parameters[0]
        Assert.False(
            ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                independent,
                otherMethod,
                []int32{0},
                other.RepositoryCompilations
            )
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes(before),
            Encoding.UTF8.GetBytes(
                GSharpPrinter.Print(
                    translator.TranslateDocument(LoadedDocument(tree.FilePath, tree, otherModel), other)
                )
            )
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes("-"),
            Encoding.UTF8.GetBytes(CompileAndRun(before, image.ToArray(), strictIl: true).Trim())
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes("-"),
            Encoding.UTF8.GetBytes(CompileAndRun(addedOutput, image.ToArray(), strictIl: true).Trim())
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes("-"),
            Encoding.UTF8.GetBytes(CompileAndRun(removedOutput, image.ToArray(), strictIl: true).Trim())
        )
    }

    @Theory
    @InlineData("add")
    @InlineData("remove")
    @InlineData("replace")
    func RefParameter_ContextCatalogSnapshotRemainsCoherentAcrossCallerMutation(change string) {
        let tree = CSharpSyntaxTree.ParseText(
            "using System; public static class Demo { private static string? slot; private static void Clear() { slot = null; } private static int Guard(ref string? text) { if(text == null)return 0; Clear(); var items = Parts<string>(\"item\"); return text.Length + items[0].Length; } private static T[] Parts<T>(T value) => new[] {value}; public static string Run() { slot = \"safe\"; try { return Guard(ref slot).ToString(); } catch(NullReferenceException) { return \"cleared\"; } } }",
            path: "CatalogRoot.cs"
        )
        let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
            NullableContextOptions.Enable
        )
        let root = CSharpCompilation.Create(
            "CatalogRoot5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let first = CSharpCompilation.Create(
            "CatalogFirst5326",
            []SyntaxTree{CSharpSyntaxTree.ParseText("public class First {}", path: "First.cs")},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let second = CSharpCompilation.Create(
            "CatalogSecond5326",
            []SyntaxTree{CSharpSyntaxTree.ParseText("public class Second {}", path: "Second.cs")},
            CSharpProjectLoader.RuntimeReferences(),
            options
        )
        let catalog = List[CSharpCompilation]{first}
        let context = TranslationContext(
            root,
            root.GetSemanticModel(tree),
            tree.FilePath,
            siblingCompilations: catalog,
            repositoryCompilations: catalog
        )
        let document = LoadedDocument(tree.FilePath, tree, context.SemanticModel)
        let ownerIndex = context.OwnershipIndexIdentity
        let effects = context.EffectIndexes
        Assert.Same(first, context.SourceCompilation(first.Assembly))
        let before = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        if change == "add" {
            catalog.Add(second)
        } else if change == "remove" {
            catalog.Clear()
        } else {
            catalog[0] = second
        }
        Assert.Same(first, Assert.Single(context.RepositoryCompilations!!))
        Assert.Same(first, Assert.Single(context.SiblingCompilations!!))
        Assert.Same(first, context.SourceCompilation(first.Assembly))
        Assert.Null(context.SourceCompilation(second.Assembly))
        Assert.Same(ownerIndex, context.OwnershipIndexIdentity)
        Assert.Same(effects, context.EffectIndexes)
        let after = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Equal(Encoding.UTF8.GetBytes(before), Encoding.UTF8.GetBytes(after))
        let fresh = TranslationContext(
            root,
            root.GetSemanticModel(tree),
            tree.FilePath,
            siblingCompilations: catalog,
            repositoryCompilations: catalog
        )
        Assert.Equal(catalog.Count, fresh.RepositoryCompilations!!.Count)
        Assert.NotSame(ownerIndex, fresh.OwnershipIndexIdentity)
        Assert.Equal(change == "add", fresh.SourceCompilation(first.Assembly) != nil)
        Assert.Equal(change != "remove", fresh.SourceCompilation(second.Assembly) != nil)
        for var index = 0; index < 48; index++ {
            let peer = TranslationContext(
                root,
                root.GetSemanticModel(tree),
                tree.FilePath,
                siblingCompilations: catalog,
                repositoryCompilations: catalog
            )
            Assert.Same(fresh.RepositoryCompilations, peer.RepositoryCompilations)
            Assert.Same(fresh.SiblingCompilations, peer.SiblingCompilations)
            Assert.Same(fresh.OwnershipIndexIdentity, peer.OwnershipIndexIdentity)
            Assert.Same(fresh.EffectIndexes, peer.EffectIndexes)
        }
        let freshOutput = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, fresh))
        let oldAgain = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("return text!!.Length", after)
        Assert.Equal(Encoding.UTF8.GetBytes(after), Encoding.UTF8.GetBytes(freshOutput))
        Assert.Equal(Encoding.UTF8.GetBytes(after), Encoding.UTF8.GetBytes(oldAgain))
        Assert.Equal(
            Encoding.UTF8.GetBytes("cleared"),
            Encoding.UTF8.GetBytes(CompileAndRun(after, Array.Empty[byte]()).Trim())
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes("cleared"),
            Encoding.UTF8.GetBytes(CompileAndRun(freshOutput, Array.Empty[byte]()).Trim())
        )
    }

    @Fact
    func RefParameter_DocumentOwnershipIsLazySharedAndCatalogVersioned() {
        let trees = Enumerable
            .Range(0, 48)
            .Select(
            (index int32) ->
            cast[SyntaxTree](CSharpSyntaxTree.ParseText("public class C$index {}", path: "C$index.cs"))
        )
            .ToArray()
        let compilation = CSharpCompilation.Create("Owners5326", trees, CSharpProjectLoader.RuntimeReferences())
        let contexts = List[TranslationContext]()
        var visits = 0
        for tree in trees {
            let model = compilation.GetSemanticModel(tree)
            let context = TranslationContext(compilation, model, tree.FilePath)
            context.BeforeOwnershipTree = func () {
                visits++
            }
            Assert.Same(model, context.GetOwnedSemanticModel(tree))
            Assert.False(context.HasOwnershipIndex)
            contexts.Add(context)
        }
        Assert.Equal(0, visits)
        for context in contexts {
            Assert.Same(contexts[0].OwnershipIndexIdentity, context.OwnershipIndexIdentity)
            Assert.Equal(trees.Length, context.OwnershipTreeEntries)
            Assert.Same(compilation, context.GetOwnedSemanticModel(trees[1]).Compilation)
        }
        Assert.Equal(trees.Length, visits)
        let other = CSharpCompilation.Create(
            "OtherOwners5326",
            []SyntaxTree{CSharpSyntaxTree.ParseText("public class Other {}", path: "Other.cs")},
            CSharpProjectLoader.RuntimeReferences()
        )
        let catalog = List[CSharpCompilation]{other}
        let withCatalog = TranslationContext(
            compilation,
            compilation.GetSemanticModel(trees[0]),
            trees[0].FilePath,
            repositoryCompilations: catalog
        )
        let sameCatalog = TranslationContext(
            compilation,
            compilation.GetSemanticModel(trees[1]),
            trees[1].FilePath,
            repositoryCompilations: catalog
        )
        Assert.Same(withCatalog.OwnershipIndexIdentity, sameCatalog.OwnershipIndexIdentity)
        Assert.NotSame(contexts[0].OwnershipIndexIdentity, withCatalog.OwnershipIndexIdentity)
        Assert.Equal(trees.Length + 1, withCatalog.OwnershipTreeEntries)
        catalog.Clear()
        let changedCatalog = TranslationContext(
            compilation,
            compilation.GetSemanticModel(trees[0]),
            trees[0].FilePath,
            repositoryCompilations: catalog
        )
        Assert.NotSame(withCatalog.OwnershipIndexIdentity, changedCatalog.OwnershipIndexIdentity)
        Assert.Equal(trees.Length, changedCatalog.OwnershipTreeEntries)
        let otherRoot = TranslationContext(other, other.GetSemanticModel(other.SyntaxTrees.Single()), "Other.cs")
        Assert.NotSame(contexts[0].OwnershipIndexIdentity, otherRoot.OwnershipIndexIdentity)
    }

    @Fact
    async func RefParameter_CancelledOwnershipWalkDoesNotPublishAndRetriesCleanly() {
        let trees = Enumerable
            .Range(0, 8)
            .Select(
            (index int32) ->
            cast[SyntaxTree](CSharpSyntaxTree.ParseText("public class Cancel$index {}", path: "Cancel$index.cs"))
        )
            .ToArray()
        let compilation = CSharpCompilation.Create(
            "CancelledOwners5326",
            trees,
            CSharpProjectLoader.RuntimeReferences()
        )
        using let cancellation = CancellationTokenSource()
        using let entered = ManualResetEventSlim()
        using let release = ManualResetEventSlim()
        let context = TranslationContext(
            compilation,
            compilation.GetSemanticModel(trees[0]),
            trees[0].FilePath,
            cancellationToken: cancellation.Token
        )
        context.BeforeOwnershipTree = func () {
            entered.Set()
            if !release.Wait(TimeSpan.FromSeconds(10)) {
                throw TimeoutException("ownership test barrier not released")
            }
        }
        let worker = Task.Run(
            func () {
                let _ = context.OwnershipIndexIdentity
            }
        )
        try {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)), "ownership walk did not enter barrier")
            cancellation.Cancel()
        } finally {
            cancellation.Cancel()
            release.Set()
            try {
                await worker.WaitAsync(TimeSpan.FromSeconds(10))
            } catch (error OperationCanceledException) { }
        }
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            async func () {
                await worker.WaitAsync(TimeSpan.FromSeconds(10))
            }
        )
        Assert.False(context.HasOwnershipIndex)
        var visits = 0
        let retry = TranslationContext(compilation, compilation.GetSemanticModel(trees[0]), trees[0].FilePath)
        retry.BeforeOwnershipTree = func () {
            visits++
        }
        Assert.Equal(trees.Length, retry.OwnershipTreeEntries)
        Assert.Equal(trees.Length, visits)
        let reuse = TranslationContext(compilation, compilation.GetSemanticModel(trees[1]), trees[1].FilePath)
        Assert.Same(retry.OwnershipIndexIdentity, reuse.OwnershipIndexIdentity)
    }

    @Fact
    func RefParameter_CompilationIndexesAreSharedAcrossDocumentVisitors() {
        let trees = Enumerable
            .Range(0, 8)
            .Select(
            (index int32) -> cast[SyntaxTree](
                CSharpSyntaxTree.ParseText(
                    "using System.Linq; public static class Part" + index.ToString() +
                        " { private static string? text; private static ref string? Slot() => ref text; private static void Clear() { text = null; } " +
                        "private static int Guard(ref string? value) { if(value == null) return 0; Clear(); _ = new[] {1}.Where(x => true).Count(); return value.Length; } }",
                    path: "Part" + index.ToString() + ".cs"
                )
            )
        )
            .ToArray()
        let compilation = CSharpCompilation.Create(
            "IndexSharing5326",
            trees,
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
        var first TranslationContext? = nil
        for tree in trees {
            let model = compilation.GetSemanticModel(tree)
            let context = TranslationContext(compilation, model, tree.FilePath)
            let initial = first ?? context
            first = initial
            Assert.Same(initial.EffectIndexes, context.EffectIndexes)
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
            )
            Assert.Contains("return value!!.Length", printed)
        }
        Assert.InRange(first!!.EffectIndexes.TreeVisits, trees.Length, trees.Length * 3)
    }

    @Fact
    func RefParameter_LoadOwnedImagesShareMetadataAndPreserveReferenceProperties() {
        let directory = Path.Combine(AppContext.BaseDirectory, "SharedImages5326", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let path = Path.Combine(directory, "System.Console.dll")
            File.Copy(typeof(Console).Assembly.Location, path)
            let snapshots = Dictionary[string, PortableExecutableReference](StringComparer.Ordinal)
            let first = TranslationContext.CreateOwnedMetadataReference(path, snapshots: snapshots)
            File.WriteAllBytes(path, []byte{0})
            for var index = 0; index < 16; index++ {
                let properties = MetadataReferenceProperties
                    .Assembly
                    .WithAliases(ImmutableArray.Create("framework"))
                    .WithEmbedInteropTypes(index % 2 == 0)
                let reference = TranslationContext.CreateOwnedMetadataReference(path, properties, snapshots)
                Assert.Equal(properties, reference.Properties)
                Assert.Same(first.GetMetadata().Id, reference.GetMetadata().Id)
                let compilation = CSharpCompilation.Create(
                    "ImageProject" + index.ToString(),
                    references: []MetadataReference{reference}
                )
                Assert.NotNull(compilation.GetAssemblyOrModuleSymbol(reference))
                Assert.True(TranslationContext.HasTrustedEffectImage(reference, typeof(Console).Assembly.FullName!!))
            }
            Assert.Single(snapshots)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func RefParameter_InvalidHostMetadataDoesNotPoisonDefaultReferences() {
        let directory = Path.Combine(AppContext.BaseDirectory, "InvalidHostMetadata5326", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let invalid = Path.Combine(directory, "InvalidDependency.dll")
            let image = CorruptMetadataImage()
            File.WriteAllBytes(invalid, image)
            using let invalidReader = PEReader(MemoryStream(image))
            Assert.True(invalidReader.HasMetadata)
            Assert.NotNull(invalidReader.PEHeaders.CorHeader)
            Assert.Throws[BadImageFormatException](
                () -> {
                    let _ = invalidReader.GetMetadataReader()
                }
            )
            let source = `
using System;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;
using Cs2Gs.Translator.Loading;
public static class Probe {
    public static int Main(string[] args) {
        AssemblyLoadContext.Default.Resolving += (context, name) => {
            var path = Path.Combine(args[0], name.Name + ".dll");
            return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
        };
        return Run(args[1]);
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run(string invalid) {
        var original = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES");
        if (!original.Split(Path.PathSeparator).Contains(invalid))
            throw new Exception("Invalid dependency is not a real host TPA input.");
        object cached = null;
        for (int pass = 0; pass < 2; pass++) {
            var loaded = CSharpProjectLoader.LoadInMemory(new[] { ("Use.cs", "public class Use {}") });
            if (!loaded.Compilation.GetDiagnostics().Any(d => d.Id == "CS0009"))
                throw new Exception("Missing original bad-reference diagnostic.");
            var reference = loaded.Compilation.References.OfType<PortableExecutableReference>()
                .Single(r => r.FilePath == invalid);
            if (!reference.Properties.Equals(MetadataReferenceProperties.Assembly))
                throw new Exception("Reference properties changed.");
            var current = CSharpProjectLoader.RuntimeReferences();
            if (cached != null && !ReferenceEquals(cached, current))
                throw new Exception("Default reference publication changed.");
            cached = current;
        }
        Console.WriteLine("CS0009|CS0009|retained|same-defaults");
        return 0;
    }
}`
            let compilation = CSharpCompilation.Create(
                "InvalidMetadataHost5326",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.ConsoleApplication)
            )
            let path = Path.Combine(directory, "Probe.dll")
            let emitted = compilation.Emit(path)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            File.WriteAllText(
                Path.ChangeExtension(path, ".runtimeconfig.json"),
                "{\"runtimeOptions\":{\"tfm\":\"net10.0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\"10.0.0\"}}}"
            )
            let (exit, output) = RunDotnet(
                path,
                Path.GetDirectoryName(typeof(CSharpProjectLoader).Assembly.Location)!!,
                invalid
            )
            Assert.True(exit == 0, output)
            Assert.Equal(
                Encoding.UTF8.GetBytes("CS0009|CS0009|retained|same-defaults" + Environment.NewLine),
                Encoding.UTF8.GetBytes(output)
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData("metadata")
    @InlineData("headers")
    @InlineData("valid")
    func RefParameter_MetadataSnapshotFallbackPreservesProperties(kind string) {
        let directory = Path.Combine(AppContext.BaseDirectory, "MetadataFallback5326", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let path = Path.Combine(directory, "System.Console.dll")
            File.WriteAllBytes(
                path,
                if kind == "metadata" {
                    CorruptMetadataImage()
                } else if kind == "headers" {
                    []byte{0}
                } else {
                    File.ReadAllBytes(typeof(Console).Assembly.Location)
                }
            )
            let properties = MetadataReferenceProperties
                .Assembly
                .WithAliases(ImmutableArray.Create("framework", "secondary"))
                .WithEmbedInteropTypes(true)
            let snapshots = Dictionary[string, PortableExecutableReference](StringComparer.Ordinal)
            let reference = TranslationContext.CreateOwnedMetadataReference(path, properties, snapshots)
            Assert.Equal(properties, reference.Properties)
            Assert.Equal(path, reference.FilePath)
            if kind == "valid" {
                Assert.Single(snapshots)
                Assert.True(TranslationContext.HasTrustedEffectImage(reference, typeof(Console).Assembly.FullName!!))
                File.Delete(path)
                Assert.Same(reference, TranslationContext.CreateOwnedMetadataReference(path, properties, snapshots))
            } else {
                Assert.Empty(snapshots)
                Assert.False(TranslationContext.HasTrustedEffectImage(reference, typeof(Console).Assembly.FullName!!))
                let compilation = CSharpCompilation.Create(
                    "InvalidReference5326",
                    references: []MetadataReference{reference}
                )
                Assert.Contains(compilation.GetDiagnostics(), (diagnostic Diagnostic) -> diagnostic.Id == "CS0009")
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func RefParameter_CanceledComparerIndexPublishesNothingAndRetriesOnce() {
        let tree = CSharpSyntaxTree.ParseText(`
using System;
using System.Linq;
using System.Collections.Generic;
public static class Demo {
    private static string? global;
    private static IEqualityComparer<int> Make() => EqualityComparer<int>.Create((x,y) => x == y, x => { global = null; return x; });
    private static void Probe() { _ = Enumerable.Count(new[] { 1 }); }
    private static int Guard(ref string? value) { if(value == null)return 0; Probe(); return value.Length; }
    public static string Run() { global = "safe"; return Guard(ref global).ToString(); }
}`, path: "IndexCancellation.cs")
        let compilation = CSharpCompilation.Create(
            "IndexCancellation5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument(tree.FilePath, tree, model)
        using let cancellation = CancellationTokenSource()
        using let entered = ManualResetEventSlim()
        using let release = ManualResetEventSlim()
        let context = TranslationContext(compilation, model, tree.FilePath, cancellationToken: cancellation.Token)
        context.AfterStorageComparerFactory = () -> {
            entered.Set()
            if !release.Wait(TimeSpan.FromSeconds(15)) {
                throw TimeoutException("Comparer index barrier was not released.")
            }
        }
        let translation = Task.Run(() -> CSharpToGSharpTranslator().TranslateDocument(document, context))
        try {
            Assert.True(
                entered.Wait(TimeSpan.FromSeconds(15)),
                "The actual comparer index scan must reach its barrier."
            )
            cancellation.Cancel()
        } finally {
            release.Set()
            Assert.Same(
                translation,
                Task.WhenAny(translation, Task.Delay(TimeSpan.FromSeconds(15))).GetAwaiter().GetResult()
            )
            context.AfterStorageComparerFactory = nil
        }
        Assert.ThrowsAny[OperationCanceledException](() -> translation.GetAwaiter().GetResult())
        Assert.Null(context.EffectIndexes.DeferredIndex)
        let retry = TranslationContext(compilation, model, tree.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, retry))
        let completed = Assert.IsType[TranslationContext.DeferredCallbackIndex](retry.EffectIndexes.DeferredIndex)
        Assert.Single(completed.Comparers)
        Assert.Empty(completed.Factories)
        let again = TranslationContext(compilation, model, tree.FilePath)
        let repeated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, again))
        Assert.Same(completed, again.EffectIndexes.DeferredIndex)
        Assert.Equal(printed, repeated)
        Assert.Contains("return value.Length", printed)
        Assert.Equal("4", CompileAndRun(printed, Array.Empty[byte]()).Trim())
    }

    @Fact
    func RefParameter_CancellationInterruptsAnActiveCalleeWalk() {
        let source = StringBuilder(
            "public static class Demo { private static void Leaf() { } private static void Work() {"
        )
        for var i = 0; i < 12000; i++ {
            source.Append("Leaf();")
        }
        source.Append(
            "} private static int Guard(ref string? s) { if (s == null) return 0; Work(); return s.Length; } }"
        )
        let tree = CSharpSyntaxTree.ParseText(source.ToString())
        let compilation = CSharpCompilation.Create(
            "CancelEffects5326",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument("Snippet.cs", tree, model)
        using let cancellation = CancellationTokenSource()
        let context = TranslationContext(compilation, model, document.FilePath, cancellationToken: cancellation.Token)
        using let entered = ManualResetEventSlim()
        using let release = ManualResetEventSlim()
        var visits = 0
        context.BeforeStorageEffectBody = () -> {
            if Interlocked.Increment(ref visits) == 1 {
                entered.Set()
                if !release.Wait(TimeSpan.FromSeconds(15)) {
                    throw TimeoutException("Callee barrier was not released.")
                }
            }
        }
        let translation = Task.Run(() -> CSharpToGSharpTranslator().TranslateDocument(document, context))
        try {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(15)), "The product callee walk must reach its barrier.")
            cancellation.Cancel()
        } finally {
            release.Set()
            Assert.Same(
                translation,
                Task.WhenAny(translation, Task.Delay(TimeSpan.FromSeconds(15))).GetAwaiter().GetResult()
            )
            context.BeforeStorageEffectBody = nil
        }
        Assert.ThrowsAny[OperationCanceledException](() -> translation.GetAwaiter().GetResult())
    }

    @Fact
    func RefParameter_ReadAroundAForEachOverACallWhoseLoopVariableIsRead_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
namespace System
{
    public static class MergedSystemExtensions
    {
        public static void InstanceParts(this int value) { }
    }
}
namespace OtherNs
{
    public static class ShadowExtensions
    {
        public static void ShadowedParts(this ShadowedBox box, int n) { }
    }
#pragma warning disable CS8618
    public static class StaticHolder
    {
        public static string[] Seed;
        public static Box Instance;
        public static string[] MakeSeed(string[] seed) => seed;
    }
#pragma warning restore CS8618
}
public interface IParent
{
    T Parts<T>(T value);
}
public interface IChild : IParent
{
    string[] Parts();
}
public sealed class ChildImpl : IChild
{
    public T Parts<T>(T value) => value;
    public string[] Parts() => new[] { "f" };
}
public sealed class GenericBox<T>
{
#pragma warning disable CS8618
    public System.Collections.Generic.List<T> StoredList;
#pragma warning restore CS8618
    public T[] GetItems(T item) => new[] { item };
    public System.Collections.Generic.List<T> Items() => StoredList;
}
public sealed class SelectBox
{
    public string[] Select() => new[] { "g" };
}
public sealed class Holder
{
    public object? Tag = "t";
    public Box Child = new Box();
}
public sealed class Unrelated { }
public sealed class DisposableBox : System.IDisposable
{
    public void Dispose() { }
    public string[] ConstrainedParts() => new[] { "z" };
}
public sealed class ChildA
{
    public string Child = "x";
}
public sealed class ChildB
{
    public int Child = 1;
}
public sealed class MixedBox
{
    public string[] MixedParts() => new[] { "x" };
    public int[] MixedParts(int n) => new[] { 1 };
    public ChildA[] MixedChildren() => new[] { new ChildA() };
    public ChildB[] MixedChildren(int n) => new[] { new ChildB() };
    public Box MixedSelf() => new Box();
    public Unrelated MixedSelf(int n) => new Unrelated();
}
public interface IBox
{
    void Ping();
}
public static class WordExtensions
{
    public static string[] WordParts(this string text) => new[] { text };
    public static string[] WordParts<T>(this string text, T tag) => new[] { text };
    public static void WordParts(this Unrelated other) { }
    public static void InstanceParts(this Unrelated other) { }
    public static void InstanceParts<T>(this T value) where T : System.IDisposable { }
    public static void ConstrainedParts<T>(this T value) where T : System.IDisposable { }
    public static int[] Entries(this int[] values) => values;
    public static string[] GenericArrayParts<T>(this T[] values) => new[] { "p" };
    public static string[] NewableParts<T>(this System.Collections.Generic.List<T> values) where T : new() => new[] { "r" };
    public static void NewablePing<T>(this T[] values) where T : new() { }
    public static string[] LibExtParts(this OtherNs.LibBox box) => new[] { "n" };
}
public sealed class Box : IBox
{
    public static string[] Parts() => new[] { "a", "b" };
    public Box Self() => this;
    public void Ping() { }
    public string[] InstanceParts() => new[] { "c" };
    public string[] InstanceParts<T>(T tag) => new[] { "c" };
    public string[] Collide(System.Collections.Generic.List<object> tags) => new[] { "k" };
    public string[] Collide<T>(System.Collections.Generic.List<T> tags) => new[] { "k" };
}
public sealed class ShadowedBox
{
    public string[] ShadowedParts() => new[] { "e" };
}
public class Demo
{
    static string[] UnqualifiedParts() => new[] { "d" };
    public static int AfterCallCollection(ref string? s)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in "a,b".Split(',')) total += part.Length;
        return s.Length + total;
    }
    public static int InsideCallCollection(ref string? s)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in "a,b".Split(','))
        {
            total += part.Length;
            total += s.Length;
        }
        return total;
    }
    public static int OverUnqualifiedStaticCall(ref string? s)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in UnqualifiedParts()) total += part.Length;
        return s.Length + total + 3;
    }
    public static int OverSourceShadowedMemberCall(ref string? s, ShadowedBox shadowed)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in shadowed.ShadowedParts()) total += part.Length;
        return s.Length + total + 5;
    }
    public static int OverInheritedInterfaceGenericOverload(ref string? s, IChild child)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in child.Parts()) total += part.Length;
        return s.Length + total + 6;
    }
    public static int OverConstructedSourceGenericReturn(ref string? s, GenericBox<string> genericBox)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in genericBox.GetItems("h")) total += part.Length;
        return s.Length + total + 7;
    }
    public static int OverSynthesizedLinqImportConflict(
        ref string? s,
        SelectBox selectBox,
        System.Linq.IOrderedEnumerable<int>? unused = null
    )
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in selectBox.Select()) total += part.Length;
        return s.Length + total + 8;
    }
    public static int OverSynthesizedGenericCollisionCall(
        ref string? s,
        Box box,
        System.Collections.Generic.List<Unrelated> tags
    )
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in box.Collide(tags)) total += part.Length;
        return s.Length + total + 9;
    }
    public static int ConditionalCopyReceiverCall(ref string? s, Box a, Box b, bool flag)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            var copy = flag ? a : b;
            copy.Ping();
            i++;
        }
        return s.Length + 10;
    }
    public static int TypeTestedCopyReceiverCall(ref string? s, Box box)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            var copy = box;
            if (copy is Box) copy.Ping();
            i++;
        }
        return s.Length + 14;
    }
    public static int OverMixedReturnOverloads(ref string? s, MixedBox mixed)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in mixed.MixedParts()) total += part.Length;
        return s.Length + total + 11;
    }
    public static int OverMixedChainedReceiverOverloads(ref string? s, MixedBox mixed)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in mixed.MixedSelf().InstanceParts()) total += part.Length;
        return s.Length + total + 12;
    }
    public static int OverMixedChainedFieldOverloads(ref string? s, MixedBox mixed)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in mixed.MixedChildren()) total += part.Child.Length;
        return s.Length + total + 20;
    }
    public static int OverMixedReturnEqualityControl(ref string? s, MixedBox mixed)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in mixed.MixedParts())
        {
            if (part == "x") total += 1;
        }
        return s.Length + total + 21;
    }
    public static int ForInitializerMemberTypeTestControl(ref string? s, Holder holder)
    {
        if (s == null) return 0;
        var i = 0;
        for (var unused = holder.Tag is string; i < 1; i++, i++)
        {
            holder.Child.Ping();
        }
        return s.Length + 22;
    }
    public static int OverConstrainedExtensionConflict(ref string? s, DisposableBox dbox)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in dbox.ConstrainedParts()) total += part.Length;
        return s.Length + total + 13;
    }
    public static int ExplicitGenericLocalReceiverCall(
        ref string? s,
        System.Collections.Generic.Stack<Box> stack
    )
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            System.Collections.Generic.Stack<Box>? copy = stack;
            copy.Peek().Ping();
            i++;
        }
        return s.Length + 17;
    }
    public static int MemberTypeTestInvalidatesMemberReceiverCall(ref string? s, Holder holder)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            if (holder.Tag is string) holder.Child.Ping();
            i++;
        }
        return s.Length + 18;
    }
    public static int ForHeaderConditionalInitializerControl(ref string? s, Box a, Box b, bool flag)
    {
        if (s == null) return 0;
        var i = 0;
        for (var copy = flag ? a : b; i < 1; i++, i++)
        {
            copy.Ping();
        }
        return s.Length + 19;
    }
    public static int ConstrainedReceiverControl<T>(ref string? s, T constrainedBox, Holder holder) where T : class, IBox
    {
        if (s == null) return 0;
        var run = true;
        while (run)
        {
            if (holder.Tag is string) constrainedBox.Ping();
            run = false;
        }
        return s.Length + 15;
    }
    public static int NewableAndStaticExtensionControl<T>(
        ref string? s,
        T[] newableItems,
        System.Collections.Generic.List<T> newableList,
        System.Collections.Generic.List<T>[] lists,
        string word
    ) where T : new()
    {
        if (s == null) return 0;
        var run = true;
        while (run)
        {
            newableItems.NewablePing();
            run = false;
        }
        var total = 0;
        foreach (var list in lists) list.Clear();
        foreach (var part in newableList.NewableParts()) total += part.Length;
        foreach (var part in WordExtensions.WordParts(word)) total += part.Length;
        return s.Length + total + 16;
    }
    public static int OverParameterArray(ref string? s, string[] parts)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in parts) total += part.Length;
        return s.Length + total + 1;
    }
    public static int OverResolvableMemberCalls(
        ref string? s,
        Box box,
        string word,
        int[] values,
        string[] parts,
        GenericBox<int> genericIntBox,
        OtherNs.LibBox libBox
    )
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in Box.Parts()) total += part.Length;
        foreach (var part in box.InstanceParts()) total += part.Length;
        foreach (var part in box.InstanceParts(1)) total += part.Length;
        foreach (var part in box.Self().InstanceParts(1)) total += part.Length;
        foreach (var part in word.WordParts()) total += part.Length;
        foreach (var entry in values.Entries()) total += entry;
        foreach (var part in values.GenericArrayParts()) total += part.Length;
        foreach (var part in libBox.LibParts()) total += part.Length;
        foreach (var part in libBox.LibExtParts()) total += part.Length;
        foreach (var part in OtherNs.StaticHolder.Seed) total += part.Length;
        foreach (var part in OtherNs.StaticHolder.MakeSeed(parts)) total += part.Length;
        foreach (var c in string.Empty) { if (c == 'a') total += 1; }
        foreach (var c in string.Intern("x"))
        {
            var copyBox = box;
            copyBox.Ping();
            Box? annotatedCopy = box;
            annotatedCopy.Ping();
            genericIntBox.Items().Clear();
            System.String.Intern("x");
            box.Self().Ping();
            OtherNs.StaticHolder.Instance.Ping();
            if (c == 'x') total += 1;
        }
        return s.Length + total + 2;
    }
    public static int OverPureStringConcatenation(ref string? s)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var c in "a" + "b")
        {
            if (c == 'a') total += 1;
        }
        return s.Length + total + 4;
    }
    public static int OverImportedByRefMemberStepCall(ref string? s, OtherNs.LibBox libBox, ChildB holder)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in libBox.LibParts(in holder.Child)) total += part.Length;
        return s.Length + total + 23;
    }
    public static string Run()
    {
        OtherNs.StaticHolder.Seed = new[] { "q" };
        OtherNs.StaticHolder.Instance = new Box();
        var genericIntBox = new GenericBox<int> { StoredList = new System.Collections.Generic.List<int>() };
        var stack = new System.Collections.Generic.Stack<Box>();
        stack.Push(new Box());
        string? text = "abc";
        return AfterCallCollection(ref text) + "," + InsideCallCollection(ref text) + "," +
            OverUnqualifiedStaticCall(ref text) + "," +
            OverSourceShadowedMemberCall(ref text, new ShadowedBox()) + "," +
            OverInheritedInterfaceGenericOverload(ref text, new ChildImpl()) + "," +
            OverConstructedSourceGenericReturn(ref text, new GenericBox<string>()) + "," +
            OverSynthesizedLinqImportConflict(ref text, new SelectBox()) + "," +
            OverSynthesizedGenericCollisionCall(ref text, new Box(), new System.Collections.Generic.List<Unrelated>()) + "," +
            ConditionalCopyReceiverCall(ref text, new Box(), new Box(), true) + "," +
            TypeTestedCopyReceiverCall(ref text, new Box()) + "," +
            OverMixedReturnOverloads(ref text, new MixedBox()) + "," +
            OverMixedChainedReceiverOverloads(ref text, new MixedBox()) + "," +
            OverMixedChainedFieldOverloads(ref text, new MixedBox()) + "," +
            OverMixedReturnEqualityControl(ref text, new MixedBox()) + "," +
            ForInitializerMemberTypeTestControl(ref text, new Holder()) + "," +
            OverConstrainedExtensionConflict(ref text, new DisposableBox()) + "," +
            ExplicitGenericLocalReceiverCall(ref text, stack) + "," +
            MemberTypeTestInvalidatesMemberReceiverCall(ref text, new Holder()) + "," +
            ForHeaderConditionalInitializerControl(ref text, new Box(), new Box(), true) + "," +
            ConstrainedReceiverControl(ref text, new Box(), new Holder()) + "," +
            NewableAndStaticExtensionControl(
                ref text,
                new[] { new Box() },
                new System.Collections.Generic.List<Box> { new Box() },
                new[] { new System.Collections.Generic.List<Box>() },
                "hi"
            ) + "," +
            OverParameterArray(ref text, new[] { "a", "b" }) + "," +
            OverResolvableMemberCalls(
                ref text,
                new Box(),
                "hi",
                new[] { 1 },
                new[] { "q" },
                genericIntBox,
                new OtherNs.LibBox()
            ) + "," +
            OverPureStringConcatenation(ref text) + "," +
            OverImportedByRefMemberStepCall(ref text, new OtherNs.LibBox(), new ChildB());
    }
}`, library: `
namespace OtherNs
{
    public class LibBox
    {
        public string[] LibParts() => new[] { "m" };
        public string[] LibParts(in int n) => new[] { "m" };
        protected void LibParts(int n) { }
        protected void LibExtParts() { }
    }
    public static class LibBoxExtensions
    {
        public static void LibParts(this LibBox box, string unused) { }
    }
}`)
        Assert.Contains("return s.Length + total\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("total += s.Length", printed)
        Assert.Contains("return s!!.Length + total + 3", printed)
        Assert.Contains("return s.Length + total + 5", printed)
        Assert.Contains("return s!!.Length + total + 6", printed)
        Assert.Contains("return s!!.Length + total + 7", printed)
        Assert.Contains("return s.Length + total + 8", printed)
        Assert.Contains("return s!!.Length + total + 9", printed)
        Assert.Contains("return s!!.Length + 10", printed)
        Assert.Contains("return s!!.Length + 14", printed)
        Assert.Contains("return s!!.Length + total + 11", printed)
        Assert.Contains("return s!!.Length + total + 12", printed)
        Assert.Contains("return s!!.Length + total + 20", printed)
        Assert.Contains("return s.Length + total + 21", printed)
        Assert.Contains("return s.Length + 22", printed)
        Assert.Contains("return s.Length + total + 13", printed)
        Assert.Contains("return s!!.Length + 17", printed)
        Assert.Contains("return s!!.Length + 18", printed)
        Assert.Contains("return s.Length + 19", printed)
        Assert.Contains("return s!!.Length + 15", printed)
        Assert.Contains("return s!!.Length + total + 16", printed)
        Assert.Contains("return s.Length + total + 1", printed)
        Assert.Contains("return s!!.Length + total + 2", printed)
        Assert.Contains("return s.Length + total + 4", printed)
        Assert.Contains("return s!!.Length + total + 23", printed)
        Assert.Equal(15, Regex.Matches(printed, `s!!`).Count)
    }

    /// Issue #5697: gsc narrows after a `do ... while`, `while`, or `for` loop whose exit condition proves non-null
    /// when the loop has no emitted `break` (`RecordLoopExitFacts`, ADR-0213 R7 (f)). A loop with a `break` (targeting
    /// it, a nested loop, a non-terminal switch break, a lowered `goto case` to an empty arm, or inside a lambda), a
    /// loop whose condition lowers to a hoisted `break` guard, a loop in a function with a lowered `goto case` or a
    /// synthesized `forContinue` label, or a loop whose condition runs an accessor or triggers an enclosing catch
    /// filter that writes the variable does not get the loop-exit fact on main, so its read after the loop stays
    /// asserted.
    @Fact
    func RefParameter_ReadAfterALoopWhoseExitConditionProvesNonNull_StaysBare() {
        let printed = AssertRunsLikeCSharp(`
using System;
public sealed class FieldValue
{
    public int Value = 1;
}
public sealed class ComputedValue
{
    public int Value => 1;
}
public sealed class Box
{
    public int F;
    public bool Again() => false;
    public static bool AgainNamed(bool repeat) => repeat;
    public FieldValue Pick() => new FieldValue();
    public ComputedValue Pick(int n) => new ComputedValue();
}
public sealed class Holder
{
    public object? Tag = "t";
    public Box Child = new Box();
}
public sealed class HidingHolder
{
    public new Func<int> GetHashCode = () => 0;
}
public partial class Demo
{
    static partial void ElidedHook(Action a);
    static bool Clear(ref string? s) { s = null; return false; }
    public static int DoLoop(ref string? s, Box box)
    {
        do { box.F = 1; s = box.F > 0 ? "abc" : null; } while (s == null);
        return s.Length + 1;
    }
    public static int DoLoopWithGuardAndForEach(ref string? s, Box box, int[] items)
    {
        if (s == null) return 0;
        do
        {
            foreach (var i in items) { box.F = i; s = i > 0 ? "abc" : null; }
        } while (s == null);
        return s.Length + 2;
    }
    public static int WhileLoop(ref string? s, Box box)
    {
        s = null;
        while (s == null)
        {
            ElidedHook(() => { while (true) { break; } });
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 3;
    }
    public static int ForLoop(ref string? s, Box box)
    {
        s = null;
        for (var i = 0; s == null; i++)
        {
            box.F = 1;
            s = i >= 0 ? "abc" : null;
        }
        return s.Length + 4;
    }
    public static int WhileLoopWithBreak(ref string? s, Box box, Lazy<int> lazy)
    {
        while (s == null)
        {
            s = "abc";
            if (lazy.Value > 0) break;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 5;
    }
    public static int WhileConditionRunsAccessor(ref string? s, Lazy<int> lazy)
    {
        while (lazy.Value < 0 || s == null)
        {
            s = "abc";
        }
        return s.Length + 6;
    }
    public static int WhileLoopWithNestedBreak(ref string? s, Box box)
    {
        s = null;
        while (s == null)
        {
            while (true) { break; }
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 7;
    }
    public static int WhileConditionHoistsOutPattern(ref string? s, object probe)
    {
        s = null;
        while (!(probe is int y && s != null))
        {
            y = 2;
            s = "abc";
        }
        return s.Length + 8;
    }
    public static int WhileConditionHoistsOutReferencePattern(ref string? s, object probe)
    {
        s = null;
        while (!(probe is Box y && s != null))
        {
            y = new Box();
            s = "abc";
        }
        return s.Length + 30;
    }
    public static int WhileLoopWithLambdaBreak(ref string? s, Box box)
    {
        s = null;
        while (s == null)
        {
            Action a = () => { while (true) { break; } };
            a();
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 9;
    }
    public static int WhileLoopWithNonTerminalSwitchBreak(ref string? s, Box box, int k)
    {
        s = null;
        while (s == null)
        {
            switch (k)
            {
                case 0:
                    if (box.F == 0) break;
                    box.F = 2;
                    break;
            }
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 10;
    }
    public static int WhileLoopInSwitchGotoFunction(ref string? s, Box box, int k)
    {
        switch (k)
        {
            case 0:
                box.F = 1;
                break;
            case 1:
                box.F = 2;
                break;
            default:
                goto case 0;
        }
        s = null;
        while (s == null)
        {
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 11;
    }
    public static int WhileLoopAfterSynthesizedForContinueLabel(ref string? s, Box box)
    {
        for (var i = 0; i < 1; i++, i++)
        {
            try { continue; } catch (Exception) { }
        }
        s = null;
        while (s == null)
        {
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 12;
    }
    public static int WhileLoopWithGotoCaseToEmptyArm(ref string? s, Box box, int k)
    {
        s = null;
        while (s == null)
        {
            switch (k)
            {
                case 0:
                    goto case 2;
                case 1:
                    box.F = 2;
                    break;
                case 2:
                    break;
            }
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 13;
    }
    public static int WhileLoopInTryWithEnclosingFilterWrite(ref string? s, Box box)
    {
        try
        {
            s = null;
            while (box.Again() || s == null)
            {
                s = "abc";
            }
            return s.Length + 14;
        }
        catch (Exception) when (Clear(ref s))
        {
            return 0;
        }
    }
    public static int WhileConditionWithConditionalReceiver(ref string? s, Box a, Box b, bool flag)
    {
        s = null;
        while ((flag ? a : b).Again() || s == null)
        {
            s = "abc";
        }
        return s.Length + 15;
    }
    public static int WhileLoopAfterPatternGuardEndLabel(ref string? s, Box box, object probe)
    {
        if (probe is int n && n > 0)
        {
            n++;
        }
        else
        {
        }
        s = null;
        while (s == null)
        {
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 16;
    }
    public static int WhileConditionCoalesceAssignNumeric(ref string? s)
    {
        long? n = null;
        s = null;
        while ((n ??= 1) < 0L || s == null)
        {
            s = "abc";
        }
        return s.Length + 17;
    }
    public static int WhileConditionRelationalPatternConversion(ref string? s, byte b)
    {
        s = null;
        while (b is > 250 || s == null)
        {
            s = "abc";
        }
        return s.Length + 18;
    }
    public static int WhileConditionWithMemberTypeTestAndMemberCall(ref string? s, Holder holder)
    {
        s = null;
        while ((holder.Tag is string && holder.Child.Again()) || s == null)
        {
            s = "abc";
        }
        return s.Length + 19;
    }
    public static int WhileConditionWithNullConditionalReceiver(ref string? s, Box? a, Box? b, bool flag)
    {
        s = null;
        while ((flag ? a : b)?.Again() == true || s == null)
        {
            s = "abc";
        }
        return s.Length + 20;
    }
    public static int WhileConditionWithDelegateInvoke(ref string? s, Func<bool> callback, bool direct)
    {
        s = null;
        while ((direct ? callback() : callback.Invoke()) || s == null)
        {
            s = "abc";
        }
        return s.Length + 21;
    }
    public static int WhileConditionWithTestedHidingFieldReceiver(ref string? s, object o)
    {
        s = null;
        while ((o is HidingHolder && o.GetHashCode() < 0) || s == null)
        {
            s = "abc";
        }
        return s.Length + 22;
    }
    public static int WhileConditionWithConditionalFieldRead(ref string? s, Box a, Box b, bool flag)
    {
        s = null;
        while ((flag ? a : b).F < 0 || s == null)
        {
            s = "abc";
        }
        return s.Length + 23;
    }
    public static int WhileConditionWithObjectNilComparison(ref string? s, object? probe)
    {
        s = null;
        while (probe == null || s == null)
        {
            probe = new object();
            s = "abc";
        }
        return s.Length + 24;
    }
    public static int WhileConditionWithNamedArgumentCall(ref string? s)
    {
        s = null;
        while (Box.AgainNamed(repeat: false) || s == null)
        {
            s = "abc";
        }
        return s.Length + 25;
    }
    public static int WhileConditionWithDominatingHidingFieldReceiver(ref string? s, object o)
    {
        if (o is HidingHolder)
        {
            s = null;
            while (o.GetHashCode() < 0 || s == null)
            {
                s = "abc";
            }
            return s.Length + 26;
        }
        return 0;
    }
    public static int WhileConditionAfterExpiredHidingFieldTypeTestControl(ref string? s, object o)
    {
        if (o is HidingHolder)
        {
        }
        s = null;
        while (o.GetHashCode() < 0 || s == null)
        {
            s = "abc";
        }
        return s.Length + 29;
    }
    public static int WhileConditionWithOverloadedReadCandidate(ref string? s, Box box)
    {
        s = null;
        while (box.Pick().Value < 0 || s == null)
        {
            s = "abc";
        }
        return s.Length + 27;
    }
    public static int WhileRefObjectExitCondition(ref object? obj)
    {
        obj = null;
        while (obj == null)
        {
            obj = "abc";
        }
        return obj.GetHashCode() > int.MinValue ? 28 : 0;
    }
    public static string Run()
    {
        string? text = "abc";
        object? obj = "abc";
        return DoLoop(ref text, new Box()) + "," + DoLoopWithGuardAndForEach(ref text, new Box(), new[] { 1 }) + "," +
            WhileLoop(ref text, new Box()) + "," + ForLoop(ref text, new Box()) + "," +
            WhileLoopWithBreak(ref text, new Box(), new Lazy<int>(() => 1)) + "," +
            WhileConditionRunsAccessor(ref text, new Lazy<int>(() => 1)) + "," +
            WhileLoopWithNestedBreak(ref text, new Box()) + "," +
            WhileConditionHoistsOutPattern(ref text, 1) + "," +
            WhileConditionHoistsOutReferencePattern(ref text, new Box()) + "," +
            WhileLoopWithLambdaBreak(ref text, new Box()) + "," +
            WhileLoopWithNonTerminalSwitchBreak(ref text, new Box(), 0) + "," +
            WhileLoopInSwitchGotoFunction(ref text, new Box(), 2) + "," +
            WhileLoopAfterSynthesizedForContinueLabel(ref text, new Box()) + "," +
            WhileLoopWithGotoCaseToEmptyArm(ref text, new Box(), 0) + "," +
            WhileLoopInTryWithEnclosingFilterWrite(ref text, new Box()) + "," +
            WhileConditionWithConditionalReceiver(ref text, new Box(), new Box(), true) + "," +
            WhileLoopAfterPatternGuardEndLabel(ref text, new Box(), 1) + "," +
            WhileConditionCoalesceAssignNumeric(ref text) + "," +
            WhileConditionRelationalPatternConversion(ref text, 3) + "," +
            WhileConditionWithMemberTypeTestAndMemberCall(ref text, new Holder()) + "," +
            WhileConditionWithNullConditionalReceiver(ref text, new Box(), new Box(), true) + "," +
            WhileConditionWithDelegateInvoke(ref text, () => false, true) + "," +
            WhileConditionWithTestedHidingFieldReceiver(ref text, new HidingHolder()) + "," +
            WhileConditionWithConditionalFieldRead(ref text, new Box(), new Box(), true) + "," +
            WhileConditionWithObjectNilComparison(ref text, null) + "," +
            WhileConditionWithNamedArgumentCall(ref text) + "," +
            WhileConditionWithDominatingHidingFieldReceiver(ref text, new HidingHolder()) + "," +
            WhileConditionAfterExpiredHidingFieldTypeTestControl(ref text, new HidingHolder()) + "," +
            WhileConditionWithOverloadedReadCandidate(ref text, new Box()) + "," +
            WhileRefObjectExitCondition(ref obj);
    }
}`)
        Assert.Contains("return s.Length + 1\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s.Length + 2", printed)
        Assert.Contains("return s.Length + 3", printed)
        Assert.Contains("return s.Length + 4", printed)
        Assert.Contains("return s!!.Length + 5", printed)
        Assert.Contains("return s!!.Length + 6", printed)
        Assert.Contains("return s.Length + 7", printed)
        Assert.Contains("return s.Length + 8", printed)
        Assert.Contains("return s!!.Length + 30", printed)
        Assert.Contains("return s.Length + 9", printed)
        Assert.Contains("return s.Length + 10", printed)
        Assert.Contains("return s!!.Length + 11", printed)
        Assert.Contains("return s!!.Length + 12", printed)
        Assert.Contains("return s.Length + 13", printed)
        Assert.Contains("return s!!.Length + 14", printed)
        Assert.Contains("return s!!.Length + 15", printed)
        Assert.Contains("return s!!.Length + 16", printed)
        Assert.Contains("return s!!.Length + 17", printed)
        Assert.Contains("return s!!.Length + 18", printed)
        Assert.Contains("return s!!.Length + 19", printed)
        Assert.Contains("return s!!.Length + 20", printed)
        Assert.Contains("return s!!.Length + 21", printed)
        Assert.Contains("return s!!.Length + 22", printed)
        Assert.Contains("return s!!.Length + 23", printed)
        Assert.Contains("return s!!.Length + 24", printed)
        Assert.Contains("return s!!.Length + 25", printed)
        Assert.Contains("return s!!.Length + 26", printed)
        Assert.Contains("return s!!.Length + 29", printed)
        Assert.Contains("return s!!.Length + 27", printed)
        Assert.Contains("obj!!.GetHashCode()", printed)
        Assert.Equal(20, Regex.Matches(printed, `s!!`).Count)
    }

    /// Issues #5637 and #5238: an accessor in an earlier operand of the same expression removes a by-reference fact
    /// for a later operand (`b.P + s.Length`, `b.Auto + s.Length`), and an enclosing `catch ... when` filter that
    /// writes a local removes its fact after a call in an earlier operand (`Resume() + s.Length`) or in an `if`
    /// condition (`if (Resume() == 0) return s.Length;`), while a read in the first operand before the call stays bare.
    @Fact
    func SameExpressionOperandOrderAndEnclosingCatchFilter_AssertsOnlyAfterEffect() {
        let printed = AssertRunsLikeCSharp(`
using System;
public class Base
{
    private int count;
    public int P => ++count;
    public virtual int Auto { get; set; } = 1;
}
public sealed class Bag : System.Collections.IEnumerable
{
    public int Count;
    public void Add(int x) => Count += x;
    public System.Collections.IEnumerator GetEnumerator() => System.Array.Empty<int>().GetEnumerator();
}
public class Demo
{
    static int Resume()
    {
        try { throw new FormatException(); }
        catch (Exception) { return 0; }
    }
    static bool Touch(ref string? s)
    {
        s = "xy";
        return false;
    }
    public static int AfterComputed(ref string? s, Base b)
    {
        if (s == null) return 0;
        return b.P + s.Length;
    }
    public static int AfterOpenAuto(ref string? s, Base b)
    {
        if (s == null) return 0;
        return b.Auto + s.Length;
    }
    public static int BeforeComputed(ref string? s, Base b)
    {
        if (s == null) return 0;
        return s.Length + b.P;
    }
    public static int FilterOperand(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            return Resume() + s.Length;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterCondition(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            if (Resume() == 0) return s.Length;
            return 0;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterControlBeforeCall(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            return s.Length + Resume();
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterControlUninvokedLocalFunction(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            int Local() => Resume();
            return s.Length + Local();
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterControlTernaryBranch(string? seed, bool flag)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            return flag ? Resume() : s.Length;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int AfterSwitchArmGetter(ref string? s, Base b, int k)
    {
        if (s == null) return 0;
        var v = k switch { 0 => b.P, _ => 1 };
        return v + s.Length;
    }
    public static int FilterCollectionAddBeforeRead(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            var list = new System.Collections.Generic.List<int> { 1, s.Length };
            return list.Count;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterFirstCollectionElementAfterCtor(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            var bag = new Bag { s.Length };
            return bag.Count;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterControlCallFreeSwitchExpression(string? seed, int k)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            var v = k switch { 0 => 1, _ => 2 };
            return v + s.Length;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    static T Id<T>(T value) => value;
    public static int FilterControlGenericFirstArgument(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            return Id<int>(value: s.Length);
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int ClosureAssignedAfterObjectCaseLabel(string? seed, object o)
    {
        var s = seed;
        System.Action reset = () => s = null;
        if (s == null) return 0;
        var v = 0;
        switch (o)
        {
            case 1:
                v = 2;
                break;
            default:
                v = 3;
                break;
        }
        return v + s.Length;
    }
    public static string Run()
    {
        string? text = "abc";
        var b = new Base();
        return AfterComputed(ref text, b) + "," + AfterOpenAuto(ref text, b) + "," + BeforeComputed(ref text, b) + "," +
            FilterOperand("abc") + "," + FilterCondition("abc") + "," + FilterControlBeforeCall("abc") + "," +
            FilterControlUninvokedLocalFunction("abc") + "," + FilterControlTernaryBranch("abc", false) + "," +
            AfterSwitchArmGetter(ref text, b, 0) + "," + FilterCollectionAddBeforeRead("abc") + "," +
            FilterFirstCollectionElementAfterCtor("abc") + "," + FilterControlCallFreeSwitchExpression("abc", 0) + "," +
            ClosureAssignedAfterObjectCaseLabel("abc", 1) + "," + FilterControlGenericFirstArgument("abc");
    }
}`)
        Assert.Contains("return b.P + s!!.Length", printed)
        Assert.Contains("return b.Auto + s!!.Length", printed)
        Assert.Contains("return s.Length + b.P", printed)
        Assert.Contains("return Resume() + s!!.Length", printed)
        Assert.Contains("return s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s.Length + Resume()", printed)
        Assert.Contains("return s.Length + Local()", printed)
        Assert.Contains("return if flag { Resume() } else { s.Length }", printed)
        Assert.Contains("return v + s!!.Length", printed)
        Assert.Contains("{ 1, s!!.Length }", printed)
        Assert.Contains("Bag(){ s!!.Length }", printed)
        Assert.Contains("return v + s.Length", printed)
        Assert.Contains("Id[int32](value: s.Length)", printed)
        Assert.Equal(2, Regex.Matches(printed, `return v \+ s!!\.Length`).Count)
    }

    /// Issue #5693: a C# struct or class with a source-declared `Deconstruct` method (instance or extension)
    /// translates to G# that compiles and runs for `var (a, b) = p`, `(a, b) = p`, and `foreach (var (a, b) in items)`,
    /// and a deconstructing `foreach` over it asserts a narrowed by-reference parameter while a straight-line
    /// deconstruction keeps it bare (amendment A3).
    @Fact
    func SourceDeconstruct_InDeclarationAssignmentAndForEach_CompilesAndMatchesNarrowing() {
        let printed = AssertRunsLikeCSharp(`
public struct Pair
{
    public int A;
    public int B;
    public void Deconstruct(out int a, out int b)
    {
        a = A;
        b = B;
    }
}
public sealed class Box<T> where T : notnull
{
    public T Value;
    public int Count;
    public Box(T value, int count)
    {
        Value = value;
        Count = count;
    }
    public void Deconstruct(out T value, out int count)
    {
        value = Value;
        count = Count;
    }
}
public struct ExtPair
{
    public int X;
    public int Y;
}
public record RecordPoint(int X, int Y);
public static class PairExtensions
{
    public static void Deconstruct(this ExtPair p, out int x, out int y)
    {
        x = p.X;
        y = p.Y;
    }
    public static void Deconstruct(this RecordPoint p, out int x, out int y, out int sum)
    {
        x = p.X;
        y = p.Y;
        sum = p.X + p.Y;
    }
}
public class Demo
{
    public static int StraightLine(ref string? s, Pair p, Box<string> box, ExtPair ep)
    {
        if (s == null) return 0;
        var (a, b) = p;
        int x, y;
        (x, y) = p;
        var (text, count) = box;
        var (ex, ey) = ep;
        return s.Length + a + b + x + y + text.Length + count + ex + ey;
    }
    public static int LoopItems(ref string? s, Pair[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items) total += a + b + s.Length;
        return s.Length + total;
    }
    public static int LoopDiscards(ref string? s, Pair[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (_, _) in items) total += 1;
        return s.Length + total + 1;
    }
    public static int LoopRecordExtensionDiscards(ref string? s, RecordPoint[] points)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (_, _, _) in points) total += 1;
        return s.Length + total + 2;
    }
    public static string Run()
    {
        string? text = "abc";
        var p = new Pair { A = 2, B = 3 };
        var items = new[] { p, new Pair { A = 4, B = 5 } };
        return StraightLine(ref text, p, new Box<string>("hi", 6), new ExtPair { X = 7, Y = 8 }) + "," +
            LoopItems(ref text, items) + "," + LoopDiscards(ref text, items) + "," +
            LoopRecordExtensionDiscards(ref text, new[] { new RecordPoint(1, 2) });
    }
}`)
        Assert.Contains("return s.Length + a + b + x + y + text!!.Length + count + ex + ey", printed)
        Assert.Contains("total += a + b + s!!.Length", printed)
        Assert.Contains("return s!!.Length + total\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s!!.Length + total + 1", printed)
        Assert.Contains("return s!!.Length + total + 2", printed)
        Assert.Equal(4, Regex.Matches(printed, `s!!`).Count)
    }

    shared {
        /// Runs `Demo.Run()` of the C# and of its translation and compares the output. [`library`](paramref) is C#
        /// that both reference as a prebuilt assembly (`Lib5617`), so its types are imported in the G#.
        private func AssertRunsLikeCSharp(
            source string,
            library string? = nil,
            inspect Action[TranslationContext]? = nil,
            cancellationToken CancellationToken = default(CancellationToken),
            runtimeOnlyLibrary bool = false
        ) string {
            let libraryImage = if library == nil {
                Array.Empty[byte]()
            } else {
                EmitCSharp(
                    if runtimeOnlyLibrary {
                        "HiddenCaller5326"
                    } else {
                        "Lib5617"
                    },
                    library
                )
            }
            let references = List[MetadataReference](CSharpProjectLoader.RuntimeReferences())
            if libraryImage.Length > 0 && !runtimeOnlyLibrary {
                references.Add(MetadataReference.CreateFromImage(libraryImage))
            }
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Snippet" + Guid.NewGuid().ToString("N"),
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            using let peStream = MemoryStream()
            let emitted = compilation.Emit(peStream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let loadContext = AssemblyLoadContext("Issue5617", isCollectible: true)
            try {
                if libraryImage.Length > 0 {
                    loadContext.LoadFromStream(MemoryStream(libraryImage))
                }
                peStream.Position = 0
                let expected = cast[string](
                    loadContext.LoadFromStream(peStream).GetType("Demo", throwOnError: true)!!.GetMethod(
                        "Run"
                    )!!.Invoke(nil, nil)
                )
                let model = compilation.GetSemanticModel(tree)
                let document = LoadedDocument("Snippet.cs", tree, model)
                let context = TranslationContext(
                    compilation,
                    model,
                    document.FilePath,
                    cancellationToken: cancellationToken
                )
                let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                inspect?.Invoke(context)
                Assert.Equal(expected, CompileAndRun(printed, libraryImage, runtimeOnlyLibrary).Trim())
                return printed
            } finally {
                loadContext.Unload()
            }
        }

        private func CorruptMetadataImage()[]byte {
            let image = File.ReadAllBytes(typeof(Console).Assembly.Location)
            using let reader = PEReader(MemoryStream(image))
            let headers = reader.PEHeaders
            let metadata = (
                headers.CorHeader ?? throw InvalidOperationException("CLI header missing.")
            ).MetadataDirectory
            let section = headers.SectionHeaders.First(
                (value SectionHeader) -> metadata.RelativeVirtualAddress >= value.VirtualAddress &&
                    metadata.RelativeVirtualAddress < value.VirtualAddress +
                    value.SizeOfRawData
            )
            let offset = section.PointerToRawData + metadata.RelativeVirtualAddress - section.VirtualAddress
            Array.Clear(image, offset, 4)
            return image
        }

        private func EmitCSharp(name string, source string)[]byte {
            let compilation = CSharpCompilation.Create(
                name,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            using let stream = MemoryStream()
            let emitted = compilation.Emit(stream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            return stream.ToArray()
        }

        private func CompileAndRun(
            printed string,
            libraryImage[]byte,
            runtimeOnlyLibrary bool = false,
            strictIl bool = false
        ) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(
                AppContext.BaseDirectory,
                "Issue5617ByReferenceAccessorNarrowingTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Snippet.gs")
                let mainPath = Path.Combine(workDir, "Main.gs")
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(gsPath, printed)
                File.WriteAllText(
                    mainPath,
                    "import System${Environment.NewLine}Console.WriteLine(Demo.Run())${Environment.NewLine}"
                )
                let arguments = List[string]{compiler!!, "/target:exe", "/out:$dllPath", gsPath, mainPath}
                let verifyReferences = List[string]()
                if libraryImage.Length > 0 {
                    let libraryPath = Path.Combine(
                        workDir,
                        if runtimeOnlyLibrary {
                            "HiddenCaller5326.dll"
                        } else {
                            "Lib5617.dll"
                        }
                    )
                    File.WriteAllBytes(libraryPath, libraryImage)
                    verifyReferences.Add(libraryPath)
                    if !runtimeOnlyLibrary {
                        arguments.Add("/r:" + libraryPath)
                    }
                }
                let (compileExit, compileOutput) = RunDotnet(arguments.ToArray())
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet. Output:\n" +
                        compileOutput +
                        "\n\nTranslated G#:\n" +
                        printed
                )
                if strictIl {
                    let verify = List[string]{"tool", "run", "ilverify", dllPath, "-s", "System.Private.CoreLib"}
                    for reference in Directory.EnumerateFiles(
                        Path.GetDirectoryName(typeof(object).Assembly.Location)!!,
                        "*.dll"
                    )
                        .Concat(verifyReferences) {
                        verify.Add("-r")
                        verify.Add(reference)
                    }
                    let (verifyExit, verifyOutput) = RunDotnet(verify.ToArray())
                    Assert.True(verifyExit == 0, verifyOutput)
                }
                // A `!!` on the by-reference read where gsc keeps the fact is GS0536.
                let lines = printed.Replace("\r\n", "\n").Split('\n')
                for diagnostic in Regex.Matches(compileOutput, `Snippet\.gs\((\d+),\d+,\d+,\d+\): warning GS0536`) {
                    let line = lines[int32.Parse(diagnostic.Groups[1].Value) - 1]
                    Assert.False(line.Contains("s!!"), "gsc keeps the fact here (GS0536): " + line)
                }
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(runExit == 0, "The translated snippet must run. Output:\n" + runOutput)
                return runOutput
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func RunDotnet(arguments ...string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("failed to start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(TimeSpan.FromMinutes(5)) {
                process.Kill(entireProcessTree: true)
                Assert.Fail("dotnet " + string.Join(' ', arguments) + " did not exit within 5 minutes.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
