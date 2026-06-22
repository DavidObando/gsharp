// <copyright file="InheritedFieldResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0112 A7: focused coverage for inherited-field resolution in the binder
/// sites routed through <see cref="TypeMemberModel.TryGetFieldIncludingInherited"/>.
/// Each method uses unique type names because FunctionTypeSymbol.Cache aliases by
/// type-name string across in-process compilations.
/// </summary>
public class InheritedFieldResolutionTests
{
    [Fact]
    public void PropertyPattern_MatchesInheritedField()
    {
        // PatternBinder: property pattern resolves a field declared on a base type.
        var source = @"
open class InhPatBase { var PatField int32 }
class InhPatDerived : InhPatBase {}
let d = InhPatDerived{PatField: 5}
let r = switch d { case { PatField: 5 }: 1 default: 0 }
r
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void NamedDeconstruction_BindsInheritedField()
    {
        // StatementBinder: `let { Field = local } = expr` resolves an inherited field.
        var source = @"
open data class InhDecBase { var DecField int32 }
data class InhDecDerived : InhDecBase { var Own int32 }
let d = InhDecDerived{DecField: 9, Own: 0}
let { DecField = a } = d
a
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
