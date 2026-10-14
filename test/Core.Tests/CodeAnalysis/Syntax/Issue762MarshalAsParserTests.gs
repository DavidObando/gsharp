// <copyright file="Issue762MarshalAsParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Parser-level coverage for ADR-0096 / issue #762 — per-parameter
/// `@MarshalAs(UnmanagedType.…)` overrides on P/Invoke
/// declarations. The grammar slot already exists (ADR-0047 annotation
/// targets on parameters), so the parser does not need a new shape —
/// these tests pin that the annotation parses without diagnostics and
/// that its arguments (positional + named) are preserved on the
/// (cref:AnnotationSyntax).
open class Issue762MarshalAsParserTests {
    @Theory
    @InlineData("LPStr")
    @InlineData("LPWStr")
    @InlineData("LPUTF8Str")
    @InlineData("BStr")
    @InlineData("Bool")
    @InlineData("VariantBool")
    @InlineData("I1")
    @InlineData("U1")
    @InlineData("I2")
    @InlineData("U2")
    @InlineData("I4")
    @InlineData("U4")
    @InlineData("I8")
    @InlineData("U8")
    @InlineData("SysInt")
    @InlineData("SysUInt")
    @InlineData("Struct")
    func MarshalAs_BareUnmanagedType_Parses(unmanagedType string) {
        let source = (`
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "x")
func native_x(@MarshalAs(UnmanagedType.` + "$unmanagedType" + `) p int32) void;
`)
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let ann = fn.Parameters[0].Annotations.Single()
        Assert.Equal("MarshalAs", ann.NameSegments[ann.NameSegments.Length - 1].Text)
    }

    @Fact
    func MarshalAs_LPArray_WithSizeParamIndex_Parses() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "sum")
func native_sum(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int32;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let ann = fn.Parameters[0].Annotations.Single()
        Assert.Equal("MarshalAs", ann.NameSegments[ann.NameSegments.Length - 1].Text)
        Assert.Equal(2, ann.Arguments.Count)
    }

    @Fact
    func MarshalAs_ByValArray_WithSizeConst_Parses() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "fixed_buf")
func native_fixed_buf(@MarshalAs(UnmanagedType.ByValArray, SizeConst: 16) buf []uint8) void;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Single(fn.Parameters[0].Annotations)
    }

    @Fact
    func MarshalAs_ByValTStr_WithSizeConst_Parses() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "take_short_str")
func native_take_short_str(@MarshalAs(UnmanagedType.ByValTStr, SizeConst: 8) s string) void;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Single(fn.Parameters[0].Annotations)
    }

    @Fact
    func MarshalAs_SafeArray_WithSafeArraySubType_Parses() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libfoo", EntryPoint: "take_sa")
func native_take_sa(@MarshalAs(UnmanagedType.SafeArray, SafeArraySubType: VarEnum.VT_I4) sa []int32) void;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Single(fn.Parameters[0].Annotations)
    }

    @Fact
    func MarshalAs_OnMultipleParameters_Parses() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("user32", EntryPoint: "MessageBoxW")
func MessageBoxW(
    hWnd nint,
    @MarshalAs(UnmanagedType.LPWStr) lpText string,
    @MarshalAs(UnmanagedType.LPWStr) lpCaption string,
    uType uint32) int32;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Empty(fn.Parameters[0].Annotations) // hWnd has none
        Assert.Single(fn.Parameters[1].Annotations) // lpText
        Assert.Single(fn.Parameters[2].Annotations) // lpCaption
        Assert.Empty(fn.Parameters[3].Annotations) // uType

    }

    @Fact
    func MarshalAs_OnLibraryImportParameter_Parses() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libfoo", EntryPoint: "sum")
func native_sum(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int32;
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }
}
