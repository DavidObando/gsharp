// <copyright file="Issue2644TransitiveGenericInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2644TransitiveGenericInterfaceTests
{
    [Fact]
    public void OahuRegionPickerModal_ConvertsToNonGenericModal()
    {
        var compilation = Compile(
            """
            package Oahu.Cli.Tui

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
            }
            """);

        Assert.Empty(GetDiagnostics(compilation));
    }

    [Fact]
    public void ConstructedInterface_ClosesEveryTransitiveGenericBase()
    {
        var compilation = Compile(
            """
            package test

            interface IRoot[T] {
                func Get() T;
            }

            interface IMiddle[T] : IRoot[T] { }
            interface ILeaf[T] : IMiddle[T] { }

            class StringLeaf : ILeaf[string] {
                func Get() string -> "ok"
            }
            """);

        Assert.Empty(GetDiagnostics(compilation));
        var leaf = compilation.GlobalScope.Structs.Single(type => type.Name == "StringLeaf");
        var root = Assert.Single(
            leaf.Interfaces.Where(
                iface => iface.Definition.Name == "IRoot"
                    && !iface.TypeArguments.IsDefaultOrEmpty));
        Assert.Same(TypeSymbol.String, Assert.Single(root.TypeArguments));
    }

    [Fact]
    public void GenericInterfaceChain_ConvertsTransitivelyToImportedBase()
    {
        var compilation = Compile(
            """
            package test
            import System

            interface IRoot[T] : IDisposable { }
            interface ILeaf[T] : IRoot[T] { }

            func Upcast(value ILeaf[string]) IDisposable {
                return value
            }
            """);

        Assert.Empty(GetDiagnostics(compilation));
    }

    [Fact]
    public void GenericInterfaceClosure_DoesNotPermitMismatchedConstruction()
    {
        var compilation = Compile(
            """
            package test

            interface IModal { }
            interface IModal[T] : IModal { }

            func Bad(modal IModal[int32]) IModal[string] {
                return modal
            }
            """);

        Assert.Contains(GetDiagnostics(compilation), diagnostic => diagnostic.Id == "GS0155");
    }

    private static Compilation Compile(string source)
        => new(SyntaxTree.Parse(SourceText.From(source)));

    private static IReadOnlyList<Diagnostic> GetDiagnostics(Compilation compilation)
        => compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics;
}
