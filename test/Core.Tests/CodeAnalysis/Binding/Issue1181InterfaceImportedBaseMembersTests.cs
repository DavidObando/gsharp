// <copyright file="Issue1181InterfaceImportedBaseMembersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1181: a user-defined interface that extends a BCL/imported interface
/// must surface that interface's inherited members (and the transitive closure
/// of any CLR interface it extends) on values typed as the user interface —
/// exactly as it already does for members inherited from a user base interface.
/// Previously member lookup only walked user base interfaces, so
/// <c>interface IBox : IDisposable</c> failed to expose <c>Dispose()</c> with
/// GS0159 / GS0158. The binder now projects the imported base interfaces'
/// CLR members onto the user-interface receiver.
/// </summary>
public class Issue1181InterfaceImportedBaseMembersTests
{
    [Fact]
    public void ImportedBaseInterfaceMethod_CalledThroughUserInterface_Binds()
    {
        const string source = """
            package p
            import System
            interface IBox : IDisposable { prop N int32 }
            func Use(b IBox) { b.Dispose() }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedBaseInterfaceMethod_NonGenericEnumerable_Binds()
    {
        const string source = """
            package p
            import System.Collections
            interface IBox : IEnumerable { prop N int32 }
            func Use(b IBox) { let e = b.GetEnumerator() }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedBaseInterfaceMethod_TransitiveGenericEnumerable_Binds()
    {
        // IEnumerable<int32> transitively extends the non-generic IEnumerable;
        // GetEnumerator must be surfaced through the whole CLR interface chain.
        const string source = """
            package p
            import System.Collections.Generic
            interface IBox : IEnumerable[int32] { prop N int32 }
            func Use(b IBox) { let e = b.GetEnumerator() }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedBaseInterfaceProperty_ReadThroughUserInterface_Binds()
    {
        // System.Collections.ICollection declares the Count property.
        const string source = """
            package p
            import System.Collections
            interface IBox : ICollection { prop N int32 }
            func Use(b IBox) int32 { return b.Count }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedBaseInterfaceMethod_ReachedThroughUserBaseInterface_Binds()
    {
        // The imported base interface is declared on a user base interface; the
        // member must still be surfaced two hops away.
        const string source = """
            package p
            import System
            interface IBase : IDisposable {}
            interface IBox : IBase { prop N int32 }
            func Use(b IBox) { b.Dispose() }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void UserBaseInterfaceMember_StillBinds()
    {
        // Control: a member inherited from a USER base interface must keep
        // working unchanged.
        const string source = """
            package p
            interface IBase { func Close(); }
            interface IBox : IBase { prop N int32 }
            func Use(b IBox) { b.Close() }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedInterfaceMember_CalledOnImportedInterfaceDirectly_StillBinds()
    {
        // Control: calling the inherited member on the BCL interface type
        // directly must keep working.
        const string source = """
            package p
            import System
            func Use(b IDisposable) { b.Dispose() }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void AbsentMethod_ThroughUserInterfaceExtendingImportedBase_ReportsGS0159()
    {
        // A genuinely-absent method must still surface "Cannot find function".
        const string source = """
            package p
            import System
            interface IBox : IDisposable { prop N int32 }
            func Use(b IBox) { b.NoSuchMethod() }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0159");
    }

    [Fact]
    public void AbsentProperty_ThroughUserInterfaceExtendingImportedBase_ReportsGS0158()
    {
        const string source = """
            package p
            import System.Collections
            interface IBox : ICollection { prop N int32 }
            func Use(b IBox) int32 { return b.NoSuchProperty }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0158");
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        // BoundProgram fully binds function bodies (where member access is
        // resolved), surfacing body-level diagnostics such as GS0158/GS0159 —
        // GlobalScope.Diagnostics only covers declaration-level binding.
        return compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToList();
    }
}
