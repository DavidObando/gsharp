// <copyright file="Issue1274ConditionalImportedBaseUnifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1274: a conditional / if-expression whose two arms are an
/// imported/BCL base class and a user-defined subclass of it (or two user
/// subclasses of the same imported base) must unify to the imported base via
/// best-common-type — matching the user-defined-base behavior. The bug was that
/// the best-common-type ancestor enumeration (and the conversion classifier)
/// only walked a user type's user-defined base chain (<c>BaseClass</c>) and did
/// not recognise the imported base recorded in
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.StructSymbol.ImportedBaseType"/>.
/// The user-defined-base controls must keep working (no regression).
/// </summary>
public class Issue1274ConditionalImportedBaseUnifyTests
{
    private const string ImportedHierarchy = @"
import System
open class MyEx : Exception { }
open class MyExA : Exception { }
open class MyExB : Exception { }
open class MyExDeep : MyExA { }
";

    private const string UserHierarchy = @"
open class Animal { }
class Dog : Animal { }
class Cat : Animal { }
";

    [Fact]
    public void ImportedBase_TrueArm_UserSubclass_FalseArm_Unifies_NoDiagnostics()
    {
        var diagnostics = Bind(ImportedHierarchy + @"
func F(b bool, e Exception) Exception {
    return if b { e } else { MyEx() }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ImportedBase_UserSubclass_TrueArm_ImportedBase_FalseArm_Unifies_NoDiagnostics()
    {
        var diagnostics = Bind(ImportedHierarchy + @"
func F(b bool, e Exception) Exception {
    return if b { MyEx() } else { e }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void TwoUserSubclasses_OfSameImportedBase_UnifyToImportedBase_NoDiagnostics()
    {
        var diagnostics = Bind(ImportedHierarchy + @"
func F(b bool, x MyExA, y MyExB) Exception {
    return if b { x } else { y }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void MultiLevelUserSubclass_VsImportedBase_UnifyToImportedBase_NoDiagnostics()
    {
        var diagnostics = Bind(ImportedHierarchy + @"
func F(b bool, e Exception, d MyExDeep) Exception {
    return if b { e } else { d }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void MultiLevelUserSubclasses_OnlySharedAncestorIsImportedBase_NoDiagnostics()
    {
        var diagnostics = Bind(ImportedHierarchy + @"
func F(b bool, d MyExDeep, y MyExB) Exception {
    return if b { d } else { y }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Ternary_ImportedBase_VsUserSubclass_Unifies_NoDiagnostics()
    {
        var diagnostics = Bind(ImportedHierarchy + @"
func F(b bool, e Exception) Exception {
    return b ? e : MyEx()
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Control_UserBase_VsUserSubclass_StillUnifies_NoDiagnostics()
    {
        var diagnostics = Bind(UserHierarchy + @"
func F(b bool, a Animal, d Dog) Animal {
    return if b { a } else { d }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Control_SiblingUserSubclasses_StillUnify_NoDiagnostics()
    {
        var diagnostics = Bind(UserHierarchy + @"
func F(b bool, c Cat, d Dog) Animal {
    return if b { c } else { d }
}
");

        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
