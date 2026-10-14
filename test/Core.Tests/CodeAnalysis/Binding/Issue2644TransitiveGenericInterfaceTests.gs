// <copyright file="Issue2644TransitiveGenericInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

class Issue2644TransitiveGenericInterfaceTests {
    @Fact
    func OahuRegionPickerModal_ConvertsToNonGenericModal() {
        let compilation = Compile(`package Oahu.Cli.Tui

interface IModal {
    func Kind() string;
}

interface IModal[T] : IModal {
    func Result() T;
}

class RegionPickerModal : IModal[string] {
    func Kind() string -> "region"
    func Result() string -> "us"
}

class Navigator {
    func ShowModal(modal IModal) string -> modal.Kind()
}

func Open(navigator Navigator, pendingRegionModal RegionPickerModal) string {
    return navigator.ShowModal(pendingRegionModal)
}`)
        Assert.Empty(GetDiagnostics(compilation))
    }

    @Fact
    func ConstructedInterface_ClosesEveryTransitiveGenericBase() {
        let compilation = Compile(`package test

interface IRoot[T] {
    func Get() T;
}

interface IMiddle[T] : IRoot[T] { }
interface ILeaf[T] : IMiddle[T] { }

class StringLeaf : ILeaf[string] {
    func Get() string -> "ok"
}`)
        Assert.Empty(GetDiagnostics(compilation))
        let leaf = compilation.GlobalScope.Structs.Single((type StructSymbol) -> type.Name == "StringLeaf")
        let root = Assert.Single(
            leaf.Interfaces.Where(
                (iface InterfaceSymbol) -> iface.Definition!!.Name == "IRoot" && !iface.TypeArguments.IsDefaultOrEmpty
            )
        )
        Assert.Same(TypeSymbol.String, Assert.Single(root.TypeArguments))
    }

    @Fact
    func GenericInterfaceChain_ConvertsTransitivelyToImportedBase() {
        let compilation = Compile(`package test
import System

interface IRoot[T] : IDisposable { }
interface ILeaf[T] : IRoot[T] { }

func Upcast(value ILeaf[string]) IDisposable {
    return value
}`)
        Assert.Empty(GetDiagnostics(compilation))
    }

    @Fact
    func GenericInterfaceClosure_RequiresCheckedCrossCast() {
        let compilation = Compile(`package test

interface IModal { }
interface IModal[T] : IModal { }

func Bad(modal IModal[int32]) IModal[string] {
    return modal
}`)
        Assert.Contains(GetDiagnostics(compilation), (diagnostic Diagnostic) -> diagnostic.Id == "GS0156")
    }

    shared {
        private func Compile(source string) Compilation -> Compilation(SyntaxTree.Parse(SourceText.From(source)))

        // Binder-inspection helper (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's bound
        // state; nothing needs to run.
        private func GetDiagnostics(compilation Compilation) IReadOnlyList[
            Diagnostic
        ] -> EmittedOracle.CompileDiagnostics(compilation)
    }
}
