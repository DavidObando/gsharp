// <copyright file="Issue1196TypeParameterToInterfaceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1196: a generic type parameter `T` constrained to an interface
/// (or base class) is implicitly convertible to that interface — for
/// assignment, argument passing, and return values — mirroring C# §10.2.12.
/// These binder tests assert the conversion no longer produces GS0155
/// ("Cannot convert type 'T' to ...").
open class Issue1196TypeParameterToInterfaceConversionTests {
    @Fact
    func TypeParameter_AssignedToConstraintInterface_NoGS0155() {
        const source = "package p\n" +
            "interface IPrim { func V() int32; }\n" +
            "func Use[T IPrim](t T) {\n" +
            "    var x IPrim = t\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func TypeParameter_PassedAsConstraintInterfaceArgument_NoGS0155() {
        const source = "package p\n" +
            "interface IPrim { func V() int32; }\n" +
            "func Take(p IPrim) { }\n" +
            "func Use[T IPrim](t T) {\n" +
            "    Take(t)\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func TypeParameter_ReturnedAsConstraintInterface_NoGS0155() {
        const source = "package p\n" +
            "interface IPrim { func V() int32; }\n" +
            "func Use[T IPrim](t T) IPrim {\n" +
            "    return t\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func TypeParameter_ConvertedToTransitiveBaseInterface_NoGS0155() {
        // T : IDerived, and IDerived : IBase — converting T to IBase must work
        // because IBase is transitively in T's effective interface set.
        const source = "package p\n" +
            "interface IBase { func B() int32; }\n" +
            "interface IDerived : IBase { func D() int32; }\n" +
            "func Use[T IDerived](t T) IBase {\n" +
            "    return t\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics.ToList()
        }
    }
}
