// <copyright file="Issue835MlcAttributeRecognitionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// Regression tests for issue #835: when the BuildTask drives gsc, well-known
/// attribute types (Obsolete, DllImport, StructLayout, …) flow through a
/// (cref:System.Reflection.MetadataLoadContext). The MLC's
/// (cref:System.Type) instances are <em>not</em> reference-equal to the
/// host process's `typeof()` literals, so any recogniser that used
/// `clrType == typeof(X)` would silently report `false` and silently
/// drop the attribute on the BuildTask path. The recognisers must compare by
/// (cref:System.Type.FullName) instead (via
/// (cref:ClrTypeUtilities.IsSameAs)).
open class Issue835MlcAttributeRecognitionTests {
    @Fact
    func Obsolete_From_Mlc_Is_Recognised() {
        let source = `package P
import System

@Obsolete("use Bar instead")
func Helper() {
}`
        let globalScope = BindWithMlc(source)
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        let attr = Assert.Single(helper.Attributes)
        // ClrType must come from the MLC (different reflection context than
        // typeof(System.ObsoleteAttribute) in the test host).
        Assert.NotNull(attr.AttributeType?.ClrType)
        Assert.NotSame(typeof(ObsoleteAttribute), attr.AttributeType.ClrType)
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.ClrType!!.FullName)
        // The whole point of #835: the recogniser must return true regardless
        // of which reflection context produced the Type instance.
        Assert.True(KnownAttributes.IsObsolete(attr))
        Assert.True(KnownAttributes.TryGetObsolete(helper.Attributes, out var message, out var isError))
        Assert.Equal("use Bar instead", message)
        Assert.False(isError)
    }

    @Fact
    func Obsolete_NamedConstructorArguments_AreReadByParameterName() {
        let source = `package P
import System

@Obsolete(message: "use Bar instead", true)
func Helper() {
}`
        let globalScope = BindWithMlc(source)
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        Assert.True(KnownAttributes.TryGetObsolete(helper.Attributes, out var message, out var isError))
        Assert.Equal("use Bar instead", message)
        Assert.True(isError)
    }

    @Fact
    func DllImport_From_Mlc_Is_Recognised() {
        let source = `package P
import System.Runtime.InteropServices

@DllImport("kernel32.dll")
func GetTickCount() uint32;`
        let globalScope = BindWithMlc(source)
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "GetTickCount")
        let attr = Assert.Single(fn.Attributes)
        Assert.NotNull(attr.AttributeType?.ClrType)
        Assert.NotSame(typeof(DllImportAttribute), attr.AttributeType.ClrType)
        Assert.Equal("System.Runtime.InteropServices.DllImportAttribute", attr.AttributeType.ClrType!!.FullName)
        // Recogniser must fire on the MLC-loaded type.
        Assert.True(KnownAttributes.IsDllImport(attr))
        Assert.NotNull(KnownAttributes.FindDllImport(fn.Attributes))
    }

    @Fact
    func StructLayout_From_Mlc_Is_Recognised() {
        let source = `package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}`
        let globalScope = BindWithMlc(source)
        let point = globalScope.Structs.Single((s StructSymbol) -> s.Name == "Point")
        let attr = Assert.Single(point.Attributes)
        Assert.NotNull(attr.AttributeType?.ClrType)
        Assert.NotSame(typeof(StructLayoutAttribute), attr.AttributeType.ClrType)
        Assert.Equal("System.Runtime.InteropServices.StructLayoutAttribute", attr.AttributeType.ClrType!!.FullName)
        // Recogniser must fire on the MLC-loaded type. If it did not, the
        // emitter would write StructLayout as a plain CustomAttribute row
        // instead of encoding it into the TypeDef's pseudo-custom flags.
        Assert.True(KnownAttributes.IsStructLayout(attr))
        Assert.NotNull(KnownAttributes.FindStructLayout(point.Attributes))
    }

    @Fact
    func Sanity_Identity_Compare_Against_Mlc_Type_Is_False() {
        // Demonstrates *why* #835 matters: a raw `clrType == typeof(X)` check
        // against an MLC-loaded type is always false even when the FullNames
        // match. The KnownAttributes recognisers must therefore key off
        // FullName (via ClrTypeUtilities.IsSameAs) rather than identity.
        let source = `package P
import System

@Obsolete
func Helper() {
}`
        let globalScope = BindWithMlc(source)
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        let attr = Assert.Single(helper.Attributes)
        let clr Type? = attr.AttributeType.ClrType
        Assert.NotNull(clr)
        // Identity compare to the host typeof(...) — *must* be false because
        // the MLC produces a distinct Type instance.
        Assert.False(clr == typeof(ObsoleteAttribute))
        // FullName-based compare — must be true. This is what
        // ClrTypeUtilities.IsSameAs implements.
        Assert.True(ClrTypeInspector.IsSameAs(clr!!, typeof(ObsoleteAttribute)))
    }

    shared {
        /// Build a (cref:ReferenceResolver) rooted at the BCL reference
        /// assemblies. Supplying explicit paths forces gsc into the
        /// (cref:System.Reflection.MetadataLoadContext) resolution path,
        /// reproducing the BuildTask scenario inside the unit-test process.
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(DllImportAttribute).Assembly.Location,
                typeof(StructLayoutAttribute).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Enumerable).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        private func BindWithMlc(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), MetadataLoadContextResolver())
        }
    }
}
