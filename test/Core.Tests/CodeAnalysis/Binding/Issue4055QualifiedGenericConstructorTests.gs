// <copyright file="Issue4055QualifiedGenericConstructorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

/// Issue #4055: a fully-qualified generic CLR type followed by a constructor
/// argument list must use the same qualified type walk and constructor binding
/// as its static-member and unqualified-constructor spellings.
class Issue4055QualifiedGenericConstructorTests {
    @Fact
    func FullyQualifiedNullableDefaultConstruction_Executes() {
        let result = EmittedOracle.Evaluate(`package P
import System

Console.WriteLine(System.Nullable[int32]().HasValue)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("False${Environment.NewLine}", result.Output)
    }

    @Fact
    func MultiSegmentGenericReferenceTypeConstruction_Executes() {
        let result = EmittedOracle.Evaluate(`package P
import System

let values = System.Collections.Generic.List[int32]()
values.Add(7)
Console.WriteLine(values[0])`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("7${Environment.NewLine}", result.Output)
    }

    @Fact
    func NestedGenericTypeArguments_Executes() {
        let result = EmittedOracle.Evaluate(`package P
import System

let values = System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[int32]]()
values["x"] = System.Collections.Generic.List[int32]()
values["x"].Add(9)
Console.WriteLine(values["x"][0])`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("9${Environment.NewLine}", result.Output)
    }

    @Fact
    func NonGenericQualifiedConstructor_StillExecutes() {
        let result = EmittedOracle.Evaluate(`package P
import System

let value = System.Text.StringBuilder("ok")
Console.WriteLine(value.ToString())`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok${Environment.NewLine}", result.Output)
    }

    @Fact
    func QualifiedGenericObjectInitializerReceiver_Executes() {
        let result = EmittedOracle.Evaluate(`package P
import System

Console.WriteLine(System.Collections.Generic.KeyValuePair[int32, string](){}.Key)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("0${Environment.NewLine}", result.Output)
    }

    @Fact
    func MissingGenericType_ReportsTerminalTypeNotNamespace() {
        let diagnostic = Assert.Single(Errors(`package P

let value = System.Collections.Generic.Missing[int32]().Count`))
        Assert.Equal("GS0157", diagnostic.Id)
        Assert.Equal(
            "Cannot find type 'Missing' in namespace 'System.Collections.Generic'. Are you missing an import?",
            diagnostic.Message
        )
        Assert.Equal("Missing", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func InapplicableGenericConstructor_ReportsOverloadNotNamespace() {
        let diagnostics = Errors(`package P

let value = System.Collections.Generic.List[int32]("not-capacity").Count`)
        Assert.Equal([]string{"GS0267"}, diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id))
    }

    @Fact
    func MissingMemberOnQualifiedGenericType_StillReportsMember() {
        let diagnostic = Assert.Single(Errors(`package P

System.Collections.Generic.List[int32].Missing()`))
        Assert.Equal("GS0159", diagnostic.Id)
        Assert.Equal("Cannot find function Missing.", diagnostic.Message)
    }

    @Fact
    func NamespaceAndSourceTypeCollision_StillBindsClrConstruction() {
        let result = EmittedOracle.Evaluate(`package P
import System

class System {
}

Console.WriteLine(System.Nullable[int32]().HasValue)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("False${Environment.NewLine}", result.Output)
    }

    @Fact
    func QualifiedGenericStaticMember_StillExecutes() {
        let result = EmittedOracle.Evaluate(`package P
import System

Console.WriteLine(System.Collections.Generic.Comparer[int32].Default.Compare(1, 2))`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("-1${Environment.NewLine}", result.Output)
    }

    @Fact
    func QualifiedGenericTypeClause_StillBinds() {
        Assert.Empty(Errors(`package P

var value System.Nullable[int32]`))
    }

    @Fact
    func QualifiedSourceConstructor_StillExecutes() {
        let result = EmittedOracle.Evaluate(`package P
import System

class Box {
    prop Value int32 -> 13
}

let box = P.Box()
Console.WriteLine(box.Value)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("13${Environment.NewLine}", result.Output)
    }

    shared {
        private func Errors(source string)[]Diagnostic -> EmittedOracle
            .Evaluate(source)
            .Diagnostics
            .Where((diagnostic Diagnostic) -> diagnostic.IsError)
            .ToArray()
    }
}
