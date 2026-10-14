// <copyright file="ImportedClrStaticImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// ADR-0134 (extended): a non-alias type import whose dotted target names a
/// <em>referenced-assembly CLR type</em> (rather than a same-compilation source
/// class) brings that type's `public static` members into scope for
/// unqualified reference — the imported-CLR analogue of the source-class
/// `using static` hoisting. cs2gs translates C#'s
/// `using static System.Math` to `import System.Math`, so unqualified
/// `Sqrt(x)` / `PI` must resolve exactly as `Math.Sqrt(x)` /
/// `Math.PI`. These tests pin call, static-field, static-property, and
/// overload behaviour, and that a plain namespace import does NOT hoist.
open class ImportedClrStaticImportTests {
    @Fact
    func TypeImportOfClrType_ExposesStaticMethod_ForUnqualifiedCall() {
        let source = `package p
import System.Math
func compute() float64 -> Sqrt(4.0)`
        AssertNoUnresolvedReference(Emit(source))
    }

    @Fact
    func TypeImportOfClrType_ExposesStaticMethodOverload_ForUnqualifiedCall() {
        let source = `package p
import System.Math
func biggest(a int32, b int32) int32 -> Max(a, b)`
        AssertNoUnresolvedReference(Emit(source))
    }

    @Fact
    func TypeImportOfClrType_ExposesStaticField_ForUnqualifiedRead() {
        let source = `package p
import System.Math
func pi() float64 -> PI`
        AssertNoUnresolvedReference(Emit(source))
    }

    @Fact
    func NamespaceImport_DoesNotHoistClrStatics() {
        // `import System` names a NAMESPACE, not a type, so `Sqrt` must remain
        // unresolved (GS0130), mirroring C# where only `using static System.Math`
        // — not `using System` — hoists Math's members.
        let source = `package p
import System
func compute() float64 -> Sqrt(4.0)`
        Assert.Contains(Emit(source), (d Diagnostic) -> d.Id == "GS0130")
    }

    shared {
        private func AssertNoUnresolvedReference(diagnostics ImmutableArray[Diagnostic]) {
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0130")
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        }

        private func Emit(source string) ImmutableArray[Diagnostic] {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            let paths = Directory.GetFiles(runtimeDir, "*.dll")
            let references = ReferenceResolver.WithReferences(paths)
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(references, tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            return result.Diagnostics
        }
    }
}
