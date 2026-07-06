// <copyright file="Issue2176ImportedPointerNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #2176 (Refs #914, ADR-0122): when gsc imports a BCL/metadata member
/// whose type is an unmanaged pointer (<c>void*</c> / <c>T*</c>,
/// <c>ELEMENT_TYPE_PTR</c>), the oblivious-nullable-reference promotion must NOT
/// wrap it in a nullable annotation. Pointers are <see cref="TypeKind.Pointer"/>
/// with <c>IsReferenceType == false</c>, so they are structurally excluded from
/// the promotion — exactly as the source-side <c>IsPromotedToNullableReference</c>
/// gate already excludes them. The imported return of
/// <c>System.IntPtr.ToPointer()</c> (declared <c>public void* ToPointer()</c>)
/// must bind as non-nullable <c>*void</c>, not <c>*void?</c>.
/// </summary>
public class Issue2176ImportedPointerNullabilityTests
{
    [Fact]
    public void ImportedVoidPointerReturn_AssignedToNonNullablePointer_NoGS0155()
    {
        const string source = @"
package R
import System
unsafe class P {
    var pBuffer *void
    unsafe func Init(pAddr System.IntPtr) void {
        pBuffer = *void(pAddr.ToPointer())
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0155");
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void ImportedVoidPointerReturn_BindsAsNonNullablePointer()
    {
        var toPointer = typeof(System.IntPtr)
            .GetMethods()
            .First(m => m.Name == "ToPointer" && m.GetParameters().Length == 0);

        var returnType = ClrNullability.GetReturnTypeSymbol(toPointer);

        Assert.IsType<PointerTypeSymbol>(returnType);
        Assert.IsNotType<NullableTypeSymbol>(returnType);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
