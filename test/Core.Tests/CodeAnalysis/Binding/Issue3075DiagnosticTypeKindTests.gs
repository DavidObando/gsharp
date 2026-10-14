// <copyright file="Issue3075DiagnosticTypeKindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3075: interface-implementation diagnostics name the actual aggregate kind.
open class Issue3075DiagnosticTypeKindTests {
    @Theory
    @InlineData("class", "Class")
    @InlineData("struct", "Struct")
    func MissingInterfaceMethod_UsesActualKind(declarationKind string, displayKind string) {
        let diagnostic = GetDiagnostic("GS0187", (`interface IContract {
    func Required() int32;
}

` + "$declarationKind" + ` Lookup : IContract {
}`))
        Assert.Equal(
            "$displayKind 'Lookup' does not implement interface method 'IContract.Required'.",
            diagnostic.Message
        )
    }

    @Theory
    @InlineData("class", "Class")
    @InlineData("struct", "Struct")
    func SealedInterfaceOutsidePackage_UsesActualKind(declarationKind string, displayKind string) {
        let diagnostic = GetDiagnostic("GS0188", `package Contracts

public sealed interface IContract {
}`, (`package Implementers
import Contracts

` + "$declarationKind" + ` Lookup : IContract {
}`))
        Assert.Equal(
            "$displayKind 'Lookup' cannot implement sealed interface 'IContract' from a different package ('Contracts').",
            diagnostic.Message
        )
    }

    @Theory
    @InlineData("class", "Class")
    @InlineData("struct", "Struct")
    func ConflictingDefaults_UsesActualKind(declarationKind string, displayKind string) {
        let diagnostic = GetDiagnostic("GS0318", (`interface IA {
    func Required() int32 { return 11 }
}

interface IB {
    func Required() int32 { return 22 }
}

` + "$declarationKind" + ` Lookup : IA, IB {
}`))
        Assert.Equal(
            "$displayKind 'Lookup' inherits conflicting default implementations of method 'Required' from interfaces 'IA' and 'IB'; declare an override on 'Lookup' to disambiguate (ADR-0085).",
            diagnostic.Message
        )
    }

    @Theory
    @InlineData("class", "Class")
    @InlineData("struct", "Struct")
    func AbstractMethodWithoutDefault_UsesActualKind(declarationKind string, displayKind string) {
        let diagnostic = GetDiagnostic("GS0320", (`interface IContract {
    func Required() int32;
    func Supplied() int32 { return 33 }
}

` + "$declarationKind" + ` Lookup : IContract {
}`))
        Assert.Equal(
            "$displayKind 'Lookup' does not implement abstract interface method 'IContract.Required', and the interface provides no default body (ADR-0085).",
            diagnostic.Message
        )
    }

    @Theory
    @InlineData("class", "Class")
    @InlineData("struct", "Struct")
    func MissingStaticVirtualMethod_UsesActualKind(declarationKind string, displayKind string) {
        let diagnostic = GetDiagnostic("GS0331", (`interface IContract {
    shared {
        func Required() int32;
    }
}

` + "$declarationKind" + ` Lookup : IContract {
}`))
        Assert.Equal(
            "$displayKind 'Lookup' does not implement static-virtual interface method 'IContract.Required', and the interface provides no default body (ADR-0089).",
            diagnostic.Message
        )
    }

    @Theory
    @InlineData("class", "Class")
    @InlineData("struct", "Struct")
    func InstanceMethodForStaticVirtualSlot_UsesActualKind(declarationKind string, displayKind string) {
        let diagnostic = GetDiagnostic("GS0332", (`interface IContract {
    shared {
        func Required() int32;
    }
}

` + "$declarationKind" + ` Lookup : IContract {
    func Required() int32 -> 11
}`))
        Assert.Equal(
            "$displayKind 'Lookup' declares instance method 'Required' but interface 'IContract.Required' is static-virtual; declare it inside a 'shared { ... }' block (ADR-0089).",
            diagnostic.Message
        )
    }

    shared {
        private func GetDiagnostic(id string, sources ...string) Diagnostic {
            let result = EmittedOracle.Evaluate(sources)
            return Assert.Single(result.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.Id == id))
        }
    }
}
