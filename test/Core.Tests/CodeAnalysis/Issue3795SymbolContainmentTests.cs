// <copyright file="Issue3795SymbolContainmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.CodeAnalysis.Analyzers.Testing;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3795: <see cref="Symbol.ContainingType"/> — the ADR-0169 counterpart
/// of Roslyn's <c>ISymbol.ContainingType</c> — used to be filled in only on the
/// analyzer driver's SYMBOL-action path. A syntax-node analyzer reaches the same
/// member symbols through <see cref="SemanticModel.GetDeclaredSymbol"/> and
/// registers no symbol action, so it saw <c>null</c> where Roslyn always has a
/// value, and every rule keyed on containment (a base-type walk, an "is declared
/// on type X" test) returned early and reported NOTHING. That is the worst
/// failure mode for an analyzer: silent under-reporting is indistinguishable
/// from having nothing to report.
/// </summary>
public class Issue3795SymbolContainmentTests
{
    private const string Source = @"package App

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
";

    /// <summary>
    /// The contract itself, with no analyzer in the way: a method declared in a
    /// class reports the class as its containing type through the semantic
    /// model. This is the assertion that fails on the pre-fix framework.
    /// </summary>
    [Fact]
    public void GetDeclaredSymbol_PopulatesContainingType()
    {
        var tree = SyntaxTree.Parse(SourceText.From(Source, "containment.gs"));
        Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message)));
        var compilation = new Core.CodeAnalysis.Compilation.Compilation(tree);
        var model = compilation.GetSemanticModel(tree);

        FunctionDeclarationSyntax declaration = tree.Root
            .DescendantNodes()
            .OfType<FunctionDeclarationSyntax>()
            .Single(function => function.Identifier.Text == "Rewrite" && function.IsOverride);

        var method = Assert.IsType<FunctionSymbol>(model.GetDeclaredSymbol(declaration));
        Assert.NotNull(method.ContainingType);
        Assert.Equal("Broken", method.ContainingType.Name);
        Assert.Equal("BoundTreeRewriter", method.ContainingType.BaseType?.Name);
    }

    /// <summary>
    /// The same fact as an analyzer sees it. The analyzer registers ONLY a
    /// syntax-node action — the shape #3795's GSA0005 has — and reports when the
    /// declaring type derives from <c>BoundTreeRewriter</c>. It fires on
    /// <c>Broken.Rewrite</c>, which is what makes the companion negative below
    /// mean something.
    /// </summary>
    [Fact]
    public void SyntaxNodeAnalyzer_SeesContainingType_AndReports()
    {
        GSharpAnalyzerVerifier<ContainingTypeAnalyzer>.VerifyAnalyzer(
            @"package App

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
",
            "TESTGSA3795");
    }

    /// <summary>
    /// Anti-vacuity companion: the same analyzer stays silent when the
    /// declaring type does NOT derive from <c>BoundTreeRewriter</c>. Silence
    /// here is evidence of the containment test discriminating, not of the
    /// analyzer never running — the test above proves it runs and fires.
    /// </summary>
    [Fact]
    public void SyntaxNodeAnalyzer_StaysSilentWhenContainingTypeDoesNotDerive()
    {
        GSharpAnalyzerVerifier<ContainingTypeAnalyzer>.VerifyAnalyzer(
            @"package App

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
");
    }

    /// <summary>
    /// Reports an override whose declaring type derives from
    /// <c>BoundTreeRewriter</c> — reduced to the one framework fact #3795 turns
    /// on, reached the way a syntax-node analyzer reaches it.
    /// </summary>
    [GSharpDiagnosticAnalyzer]
    public sealed class ContainingTypeAnalyzer : GSharpDiagnosticAnalyzer
    {
        private static readonly DiagnosticDescriptor Rule = new(
            "TESTGSA3795",
            "Override inside a rewriter",
            "The declaring type derives from BoundTreeRewriter.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true);

        /// <inheritdoc/>
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

        /// <inheritdoc/>
        public override void Initialize(AnalysisContext context)
        {
            context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.FunctionDeclaration);
        }

        private static void Analyze(SyntaxNodeAnalysisContext context)
        {
            var declaration = (FunctionDeclarationSyntax)context.Node;
            if (!declaration.IsOverride
                || context.SemanticModel.GetDeclaredSymbol(declaration, context.CancellationToken) is not FunctionSymbol method)
            {
                return;
            }

            for (var current = method.ContainingType?.BaseType; current is not null; current = current.BaseType)
            {
                if (current.Name == "BoundTreeRewriter")
                {
                    context.ReportDiagnostic(Diagnostic.Create(Rule, declaration.Identifier.Location));
                    return;
                }
            }
        }
    }
}
