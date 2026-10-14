// <copyright file="Issue2176ImportedPointerNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #2176 (Refs #914, ADR-0122): when gsc imports a BCL/metadata member
/// whose type is an unmanaged pointer (`void*` / `T*`,
/// `ELEMENT_TYPE_PTR`), the oblivious-nullable-reference promotion must NOT
/// wrap it in a nullable annotation. Pointers are (cref:TypeKind.Pointer)
/// with `IsReferenceType == false`, so they are structurally excluded from
/// the promotion — exactly as the source-side `IsPromotedToNullableReference`
/// gate already excludes them. The imported return of
/// `System.IntPtr.ToPointer()` (declared `public void* ToPointer()`)
/// must bind as non-nullable `*void`, not `*void?`.
open class Issue2176ImportedPointerNullabilityTests {
    @Fact
    func ImportedVoidPointerReturn_AssignedToNonNullablePointer_NoGS0155() {
        const source = `
package R
import System
unsafe class P {
    var pBuffer *void
    unsafe func Init(pAddr System.IntPtr) void {
        pBuffer = *void(pAddr.ToPointer())
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ImportedVoidPointerReturn_BindsAsNonNullablePointer() {
        let toPointer = typeof(nint).GetMethods().First(
            (m MethodInfo) -> m.Name == "ToPointer" && m.GetParameters().Length == 0
        )
        let returnType = ClrNullability.GetReturnTypeSymbol(toPointer)
        Assert.IsType[PointerTypeSymbol](returnType)
        Assert.IsNotType[NullableTypeSymbol](returnType)
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }
    }
}
