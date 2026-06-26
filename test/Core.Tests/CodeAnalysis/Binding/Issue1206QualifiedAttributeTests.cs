// <copyright file="Issue1206QualifiedAttributeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression coverage for issue #1206: namespace-qualified attribute names
/// (e.g. <c>@System.Obsolete</c>, <c>@System.ObsoleteAttribute</c>,
/// <c>@System.Runtime.InteropServices.DllImport</c>) must resolve without an
/// <c>import</c>, mirroring how qualified type references resolve. The resolver
/// must split <c>Ns.Name</c> and resolve the type by full name, append the
/// <c>Attribute</c> suffix to the final simple-name segment only (never produce
/// a doubled <c>...AttributeAttribute</c>), and the type-identity-based
/// P/Invoke detection must recognise the qualified <c>@DllImport</c>.
/// </summary>
public class Issue1206QualifiedAttributeTests
{
    [Fact]
    public void Qualified_Obsolete_Resolves_Without_Import()
    {
        var globalScope = BindSource("@System.Obsolete(\"x\")\nfunc Helper() {\n}\n");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");

        var attr = Assert.Single(helper.Attributes);
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name);
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), d => d.Id == "GS0198");
    }

    [Fact]
    public void Qualified_ObsoleteAttribute_Resolves_Without_Double_Suffix()
    {
        // The explicit `Attribute` suffix must NOT produce
        // `System.ObsoleteAttributeAttribute`.
        var globalScope = BindSource("@System.ObsoleteAttribute(\"x\")\nfunc Helper() {\n}\n");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");

        var attr = Assert.Single(helper.Attributes);
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name);
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), d => d.Id == "GS0198");
    }

    [Fact]
    public void Unqualified_Obsolete_Still_Resolves_With_Import()
    {
        var globalScope = BindSource("import System\n@Obsolete(\"x\")\nfunc Helper() {\n}\n");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");

        var attr = Assert.Single(helper.Attributes);
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name);
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), d => d.Id == "GS0198");
    }

    [Fact]
    public void Qualified_Unknown_Attribute_Still_Reports_GS0198()
    {
        var globalScope = BindSource("@System.DoesNotExistAnywhere\nfunc Helper() {\n}\n");

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0198");
    }

    [Fact]
    public void Qualified_DllImport_Is_Recognised_As_PInvoke()
    {
        const string source = @"
package P

unsafe class C {
    shared {
        @System.Runtime.InteropServices.DllImport(""kernel32"", SetLastError: true)
        func ReadFile(handle System.IntPtr, pBuffer *void, n int32, pRead *int32, ov int32) bool;
    }
}
";
        var globalScope = BindSource(source);

        var fn = GetAllFunctions(globalScope).Single(f => f.Name == "ReadFile");
        Assert.True(fn.IsPInvoke);
        Assert.NotNull(fn.PInvokeMetadata);
        Assert.Equal("kernel32", fn.PInvokeMetadata.LibraryName);
        Assert.True(fn.PInvokeMetadata.SetLastError);

        // Neither the unresolved-attribute (GS0198) nor the bodyless-without-
        // DllImport (GS0325) diagnostic may appear.
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), d => d.Id is "GS0198" or "GS0325");
    }

    private static IEnumerable<GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol> GetAllFunctions(BoundGlobalScope scope)
    {
        foreach (var fn in scope.Functions)
        {
            yield return fn;
        }

        foreach (var type in scope.Structs)
        {
            foreach (var fn in type.Methods)
            {
                yield return fn;
            }

            foreach (var fn in type.StaticMethods)
            {
                yield return fn;
            }
        }
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> GetBinderDiagnostics(BoundGlobalScope scope)
    {
        return scope.Diagnostics;
    }
}
