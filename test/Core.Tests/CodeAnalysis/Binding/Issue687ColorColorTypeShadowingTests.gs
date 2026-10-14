// <copyright file="Issue687ColorColorTypeShadowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #687: a class field whose simple name shadows an imported type used to
/// make the type unreachable from within the same class — the binder always
/// preferred the field, and even the fully-qualified namespace path
/// (`System.IO.Path.Combine(...)`) failed to bind. These tests cover the
/// two-pronged fix:
/// - Option A — C# "color color" rule (ECMA-334 §12.7.4.1): when an identifier names both a value and a
/// same-named type and the right-hand side of the accessor matches a static member of that type, prefer
/// the type. Fall back to the instance interpretation when no static member matches.
/// - Option B — a fully-qualified namespace-traversal path (`System.IO.Path.Combine(...)`) binds
/// against the type at the end of the chain whenever the leading namespace is reachable via an in-scope
/// import (including the implicit `System` import).
open class Issue687ColorColorTypeShadowingTests {
    @Fact
    func ColorColor_FieldShadowsImportedType_StaticCallBinds() {
        let source = `package P
import System.IO

class Entry {
    var Path string = ""

    func Build(suffix string) string {
        return Path.Combine(this.Path, suffix)
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ColorColor_FieldShadowsType_StaticCallWithImplicitSystem_Binds() {
        // `Type` is a System.Type and the field is named the same. Calling
        // `Type.GetType(...)` should bind against System.Type even though the
        // field shadows the simple name.
        let source = `package P

class Holder {
    var Type string = "System.Int32"

    func Resolve() bool {
        return Type.GetType(this.Type) != nil
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ColorColor_FieldOnly_NotShadowed_StillBindsAsField() {
        // No matching type — `Name` is just a string field — instance member
        // access (string.Length / no static match) must still go through the
        // field interpretation rather than reporting GS0157.
        let source = `package P

class Person {
    var Name string = ""

    func NameLength() int32 {
        return Name.Length
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ColorColor_FieldShadowsType_InstanceMemberAccess_FallsBackToField() {
        // `Path` field of type string — there is a matching imported type
        // (System.IO.Path) but the member used (`Length`) is NOT a static of
        // System.IO.Path, so the binder must keep the instance interpretation
        // and bind `Path.Length` against the string field.
        let source = `package P
import System.IO

class Probe {
    var Path string = ""

    func PathLength() int32 {
        return Path.Length
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ColorColor_BareFieldRead_StillBindsToField() {
        // `return Path` (no member access) must still resolve to the field
        // value, not a type symbol. The color-color rule only kicks in for
        // member-access positions.
        let source = `package P
import System.IO

class Probe {
    var Path string = "/tmp"

    func GetPath() string {
        return Path
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func QualifiedNamespacePath_StaticCall_Binds() {
        // Option B: `System.IO.Path.Combine(...)` is a fully qualified
        // namespace path. With the implicit `import System` and an explicit
        // `import System.IO` in scope, the binder must walk the namespace
        // segments and bind the static call against System.IO.Path.
        let source = `package P
import System.IO

class Probe {
    var Path string = ""

    func Combine(suffix string) string {
        return System.IO.Path.Combine(this.Path, suffix)
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func QualifiedNamespacePath_TopLevel_StaticCall_Binds() {
        // Even outside a colliding-field context, the qualified path must
        // resolve: a regression test for the namespace-traversal extension to
        // `TryBindImportAccessor`.
        let source = `package P

func Run() string {
    return System.IO.Path.Combine("a", "b")
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func QualifiedNamespacePath_StaticMemberAccess_Binds() {
        let source = `package P

func Sep() string {
    return System.IO.Path.DirectorySeparatorChar.ToString()
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func QualifiedNamespacePath_DeepChain_Binds() {
        let source = `package P

func Encoded() string {
    return System.Text.Encoding.UTF8.WebName
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ColorColor_LocalShadowsType_StaticCallBinds() {
        // The color-color rule should also work when a local variable, not a
        // field, is what shadows the imported type.
        let source = `package P
import System.IO

func Build() string {
    var Path = "/tmp"
    return Path.Combine(Path, "file.txt")
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ColorColor_ParameterShadowsType_StaticCallBinds() {
        let source = `package P
import System.IO

func Build(Path string, suffix string) string {
    return Path.Combine(Path, suffix)
}`
        Assert.Empty(Bind(source))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
