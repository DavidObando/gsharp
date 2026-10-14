// <copyright file="Issue3795SymbolContainmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.CodeAnalysis.Analyzers.Testing
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #3795: (cref:Symbol.ContainingType) — the ADR-0169 counterpart
/// of Roslyn's `ISymbol.ContainingType` — used to be filled in only on the
/// analyzer driver's SYMBOL-action path. A syntax-node analyzer reaches the same
/// member symbols through (cref:SemanticModel.GetDeclaredSymbol) and
/// registers no symbol action, so it saw `null` where Roslyn always has a
/// value, and every rule keyed on containment (a base-type walk, an "is declared
/// on type X" test) returned early and reported NOTHING. That is the worst
/// failure mode for an analyzer: silent under-reporting is indistinguishable
/// from having nothing to report.
open class Issue3795SymbolContainmentTests {
    /// The contract itself, with no analyzer in the way: a method declared in a
    /// class reports the class as its containing type through the semantic
    /// model. This is the assertion that fails on the pre-fix framework.
    @Fact
    func GetDeclaredSymbol_PopulatesContainingType() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "containment.gs"))
        Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select((d Diagnostic) -> d.Message)))
        let compilation = Compilation(tree)
        let model = compilation.GetSemanticModel(tree)
        let declaration = tree
            .Root
            .DescendantNodes()
            .OfType[FunctionDeclarationSyntax]()
            .Single(
            (function FunctionDeclarationSyntax) -> function.Identifier.Text == "Rewrite" && function.IsOverride
        )
        let method = Assert.IsType[FunctionSymbol](model.GetDeclaredSymbol(declaration))
        Assert.NotNull(method.ContainingType)
        Assert.Equal("Broken", method.ContainingType!!.Name)
        Assert.Equal("BoundTreeRewriter", method.ContainingType!!.BaseType?.Name)
    }

    /// The same fact as an analyzer sees it. The analyzer registers ONLY a
    /// syntax-node action — the shape #3795's GSA0005 has — and reports when the
    /// declaring type derives from `BoundTreeRewriter`. It fires on
    /// `Broken.Rewrite`, which is what makes the companion negative below
    /// mean something.
    @Fact
    func SyntaxNodeAnalyzer_SeesContainingType_AndReports() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[ContainingTypeAnalyzer].VerifyAnalyzer(`package App

open class BoundTreeRewriter {
    protected open func Rewrite(node int32) int32 {
        return node
    }
}

open class Broken : BoundTreeRewriter {
    protected open override func [|Rewrite|](node int32) int32 {
        return node
    }
}
`, "TESTGSA3795")
    }

    /// Anti-vacuity companion: the same analyzer stays silent when the
    /// declaring type does NOT derive from `BoundTreeRewriter`. Silence
    /// here is evidence of the containment test discriminating, not of the
    /// analyzer never running — the test above proves it runs and fires.
    @Fact
    func SyntaxNodeAnalyzer_StaysSilentWhenContainingTypeDoesNotDerive() {
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier[ContainingTypeAnalyzer].VerifyAnalyzer(`package App

open class Other {
    open func Rewrite(node int32) int32 {
        return node
    }
}

open class Unrelated : Other {
    override func Rewrite(node int32) int32 {
        return node
    }
}
`)
    }

    /// Reports an override whose declaring type derives from
    /// `BoundTreeRewriter` — reduced to the one framework fact #3795 turns
    /// on, reached the way a syntax-node analyzer reaches it.
    @GSharpDiagnosticAnalyzer
    class ContainingTypeAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) {
            context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.FunctionDeclaration)
        }

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA3795",
                "Override inside a rewriter",
                "The declaring type derives from BoundTreeRewriter.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )

            private func Analyze(context SyntaxNodeAnalysisContext) {
                let declaration = cast[FunctionDeclarationSyntax](context.Node)
                if !declaration.IsOverride || context.SemanticModel.GetDeclaredSymbol(
                    declaration,
                    context.CancellationToken
                ) is not FunctionSymbol method {
                    return
                }
                for var current TypeSymbol? = method
                    .ContainingType
                    ?.BaseType;
                    current != nil;
                    current = current!!
                    .BaseType {
                    if current.Name == "BoundTreeRewriter" {
                        context.ReportDiagnostic(Diagnostic.Create(Rule, declaration.Identifier.Location))
                        return
                    }
                }
            }
        }
    }

    shared {
        private const Source string = `package App

open class BoundTreeRewriter {
    protected open func Rewrite(node int32) int32 {
        return node
    }
}

open class Broken : BoundTreeRewriter {
    protected open override func Rewrite(node int32) int32 {
        return node
    }
}

class Unrelated {
    func Rewrite(node int32) int32 {
        return node
    }
}
`
    }
}
