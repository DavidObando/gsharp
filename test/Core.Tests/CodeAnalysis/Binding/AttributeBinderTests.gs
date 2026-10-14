// <copyright file="AttributeBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Text.Json.Serialization
import Xunit

/// Tests for ADR-0047 Phase 2 attribute binding: name resolution against the
/// declaring scope, use-site target validation, and compile-time constant
/// argument checking. Annotations on type aliases and parameters are bound
/// for diagnostics; the bound-attribute list itself is asserted via the
/// owning (cref:GSharp.Core.CodeAnalysis.Symbols.Symbol.Attributes)
/// slot for functions, structs, and interfaces.
open class AttributeBinderTests {
    @Fact
    func Resolves_Obsolete_With_Attribute_Suffix() {
        // `@Obsolete` resolves to System.ObsoleteAttribute via the suffix rule.
        let globalScope = BindSource(`@Obsolete
func Helper() {
}
`)
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        Assert.Single(helper.Attributes)
        Assert.Equal("System.ObsoleteAttribute", helper.Attributes[0].AttributeType.Name)
        Assert.Equal(AttributeTargetKind.Method, helper.Attributes[0].Target)
        Assert.Empty(GetBinderDiagnostics(globalScope))
    }

    @Fact
    func Resolves_Obsolete_With_Message_Argument() {
        let globalScope = BindSource(`@Obsolete("use Bar instead")
func Foo() {
}
`)
        let foo = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Foo")
        let attr = Assert.Single(foo.Attributes)
        let posArg = Assert.Single(attr.PositionalArguments)
        Assert.Equal("use Bar instead", posArg.Value)
        Assert.Empty(GetBinderDiagnostics(globalScope))
    }

    @Fact
    func Reports_Unknown_Attribute_Type() {
        let globalScope = BindSource(`@DoesNotExistAnywhere
func Helper() {
}
`)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0198")
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        Assert.Empty(helper.Attributes)
    }

    @Fact
    func Reports_When_Type_Is_Not_An_Attribute() {
        // `int` resolves but is not a System.Attribute subclass — must report GS0200.
        let globalScope = BindSource(`@int32
func Helper() {
}
`)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0200")
    }

    @Fact
    func Issue1921_PlainColonAttributeBase_DoesNotReportGS0200() {
        // Issue #1921: a same-compilation user class with a plain
        // `: Attribute` base clause (no `@Attribute` declaration sugar) must
        // be recognized as a valid attribute type — GS0200 previously fired
        // here because IsAttributeType only consulted the IsAttributeClass
        // sugar flag or the (still-null, pre-emission) ClrType, never the
        // symbol-level BaseClass/ImportedBaseType chain.
        let globalScope = BindSource(`class NoteAttribute : Attribute {
}

@Note
func Helper() {
}
`)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0200")
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        Assert.Single(helper.Attributes)
        Assert.Equal("NoteAttribute", helper.Attributes[0].AttributeType.Name)
    }

    @Fact
    func Issue1921_FullyQualifiedSystemAttributeBase_DoesNotReportGS0200() {
        // Same as above but spelled with the fully-qualified base name.
        let globalScope = BindSource(`class NoteAttribute : System.Attribute {
}

@Note
func Helper() {
}
`)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0200")
    }

    @Fact
    func Issue1921_NamedArgumentOnUserAttribute_ReportsGS0466() {
        // Code-review follow-up: a named (property/field-style) argument on a
        // same-compilation user attribute type used to bind clean and then be
        // silently dropped by the emitter (never written to metadata). It
        // must now be rejected at bind time with a clear diagnostic instead.
        let source = `class NoteAttribute : Attribute {
    var Tag string = ""
}

@Note(Tag: "x")
func Helper() {
}`
        let globalScope = BindSource(source)
        Assert.Contains(
            GetBinderDiagnostics(globalScope),
            (d Diagnostic) -> d.Id == "GS0466" && d.Message.Contains("Tag")
        )
    }

    @Fact
    func Issue1921_NamedArgumentOnClrAttribute_StillWorks() {
        // Sanity check: the GS0466 rejection is scoped to same-compilation
        // user attribute types only; a CLR-imported attribute with named args
        // (e.g. System.Diagnostics.Conditional's implicit named-arg support
        // via AttributeUsage) must be unaffected. Using a positional-only CLR
        // attribute here since most BCL attributes usable from G# take no
        // named args; this asserts no GS0466 leaks onto the CLR path.
        let globalScope = BindSource(`@Obsolete("msg")
func Helper() {
}
`)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0466")
    }

    @Fact
    func Reports_Invalid_Use_Site_Target_On_Function() {
        // `@field:` is not valid on a function declaration.
        let globalScope = BindSource(`@field:Obsolete
func Helper() {
}
`)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0201")
    }

    @Fact
    func Issue3082_PropertyTarget_On_DataPositionalMember_BindsToSynthesizedProperty() {
        let _ = typeof(JsonIgnoreAttribute).Assembly
        let source = `import System.Text.Json.Serialization

data class QuestionResult(
    QuestionId string,
    @property:JsonIgnore Points float64) {
}`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0201")
        let result = globalScope.Structs.Single((s StructSymbol) -> s.Name == "QuestionResult")
        let parameter = result.PrimaryConstructorParameters.Single((p ParameterSymbol) -> p.Name == "Points")
        Assert.Empty(parameter.Attributes)
        let property = result.Properties.Single((p PropertySymbol) -> p.Name == "Points")
        let attribute = Assert.Single(property.Attributes)
        Assert.Equal(AttributeTargetKind.Property, attribute.Target)
        Assert.Equal("System.Text.Json.Serialization.JsonIgnoreAttribute", attribute.AttributeType.Name)
    }

    @Fact
    func Allows_Return_Use_Site_Target_On_Function() {
        // `[Description]` carries `[AttributeUsage(All)]`, which includes
        // ReturnValue (issue #177).
        let globalScope = BindSource(`import System.ComponentModel
@return:Description("x")
func Helper() int32 {
return 0
}
`)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0201")
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        let attr = Assert.Single(helper.Attributes)
        Assert.Equal(AttributeTargetKind.Return, attr.Target)
    }

    @Fact
    func Reports_Non_Constant_Attribute_Argument() {
        // A nameof(...) expression isn't a recognised literal-shaped constant
        // for v1 — it must report GS0202.
        let globalScope = BindSource(`@Obsolete(nameof(Helper))
func Helper() {
}
`)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0202")
    }

    @Fact
    func Attaches_Attributes_To_Struct_Symbol() {
        let source = `
@Obsolete
struct Point {
    var X int32
    var Y int32
}
`
        let globalScope = BindSource(source)
        let point = globalScope.Structs.Single((t StructSymbol) -> t.Name == "Point")
        Assert.Single(point.Attributes)
        Assert.Equal(AttributeTargetKind.Type, point.Attributes[0].Target)
    }

    @Fact
    func Reports_Invalid_Use_Site_Target_On_Struct() {
        let source = `
@method:Obsolete
struct Point {
    var X int32
}
`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0201")
    }

    @Fact
    func Binds_Multiple_Stacked_Annotations() {
        let globalScope = BindSource(`@Obsolete
@Obsolete("again")
func Helper() {
}
`)
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        Assert.Equal(2, helper.Attributes.Length)
    }

    @Fact
    func AttributeSugar_Marks_Class_As_AttributeClass_And_Does_Not_Emit_Marker_Attribute() {
        let source = `package P
import System

@Attribute
class Trace {
}`
        let globalScope = BindSource(source)
        let trace = globalScope.Structs.Single((s StructSymbol) -> s.Name == "Trace")
        Assert.True(trace.IsAttributeClass)
        // The @Attribute marker is sugar — it must NOT appear in Symbol.Attributes
        // (since System.Attribute is not itself an applicable attribute).
        Assert.Empty(trace.Attributes)
        Assert.Empty(GetBinderDiagnostics(globalScope))
    }

    @Fact
    func AttributeSugar_Tolerates_Explicit_System_Attribute_Base() {
        let source = `package P
import System

@Attribute
class Trace : Attribute {
}`
        let globalScope = BindSource(source)
        let trace = globalScope.Structs.Single((s StructSymbol) -> s.Name == "Trace")
        Assert.True(trace.IsAttributeClass)
        Assert.Empty(GetBinderDiagnostics(globalScope))
    }

    @Fact
    func AttributeSugar_Reports_Conflict_With_Other_Explicit_Base() {
        let source = `package P
import System

open class Other {
}

@Attribute
class Trace : Other {
}`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0203")
    }

    @Fact
    func Obsolete_Warning_Is_Reported_At_Call_Site() {
        let source = `@Obsolete("use Bar")
func Old() {
}

func Main() {
    Old()
}`
        let program = BindProgramFromSource(source)
        let diags = program.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0204").ToList()
        let obsoleteDiag = Assert.Single(diags)
        Assert.Equal(DiagnosticSeverity.Warning, obsoleteDiag.Severity)
        Assert.Contains("Old", obsoleteDiag.Message)
        Assert.Contains("use Bar", obsoleteDiag.Message)
    }

    @Fact
    func Obsolete_With_IsError_Promotes_To_Error() {
        let source = `@Obsolete("dead", true)
func Old() {
}

func Main() {
    Old()
}`
        let program = BindProgramFromSource(source)
        let obsoleteDiag = Assert.Single(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
        Assert.Equal(DiagnosticSeverity.Error, obsoleteDiag.Severity)
    }

    @Fact
    func Reserved_CompilerGenerated_Attribute_Is_Rejected() {
        let source = `import System.Runtime.CompilerServices

@CompilerGenerated
func Helper() {
}`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0205")
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        Assert.Empty(helper.Attributes)
    }

    @Fact
    func Reserved_Extension_Attribute_Is_Rejected() {
        let source = `import System.Runtime.CompilerServices

@Extension
func Helper() {
}`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0205")
    }

    @Fact
    func DllImport_With_ManagedBody_Is_Rejected_By_ADR0086() {
        // Issue #727 / ADR-0086: `@DllImport` is now accepted as the P/Invoke
        // opt-in attribute. A managed body on a P/Invoke declaration is
        // rejected with GS0324 — the historical GS0211 blanket rejection has
        // been retired.
        let source = `import System.Runtime.InteropServices

@DllImport("user32.dll")
func MessageBox() {
}`
        let globalScope = BindSource(source)
        let diag = Assert.Single(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0324")
        Assert.Contains("MessageBox", diag.Message)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0211")
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "MessageBox")
        Assert.Single(fn.Attributes)
    }

    @Fact
    func DllImport_With_Attribute_Suffix_And_ManagedBody_Is_Rejected() {
        // Type-identity check must catch the explicit `DllImportAttribute` name
        // as well, not just the suffix-resolved short form. Post-ADR-0086 the
        // shape error is GS0324 (managed body), not GS0211.
        let source = `import System.Runtime.InteropServices

@DllImportAttribute("user32.dll")
func MessageBox() {
}`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0324")
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0211")
    }

    @Fact
    func Obsolete_Warning_Is_Reported_At_Class_Constructor_Call() {
        // #175: extend GS0204 to primary-constructor calls on classes.
        let source = `@Obsolete("retired")
class Old (value int32) {
}

func Main() {
    let x = Old(5)
}`
        let program = BindProgramFromSource(source)
        let diag = Assert.Single(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
        Assert.Equal(DiagnosticSeverity.Warning, diag.Severity)
        Assert.Contains("Old", diag.Message)
        Assert.Contains("retired", diag.Message)
    }

    @Fact
    func Obsolete_Warning_Is_Reported_At_Struct_Literal() {
        // #175: extend GS0204 to struct/class literal expressions.
        let source = `@Obsolete
data struct Point {
    var X int32
    var Y int32
}

func Main() {
    let p = Point{ X: 1, Y: 2 }
}`
        let program = BindProgramFromSource(source)
        let diag = Assert.Single(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
        Assert.Equal(DiagnosticSeverity.Warning, diag.Severity)
        Assert.Contains("Point", diag.Message)
    }

    @Fact
    func Obsolete_Warning_Is_Reported_At_Type_Clause_Reference() {
        // #175: extend GS0204 to named type references in type position.
        // Marking a struct obsolete and naming it as a parameter type
        // surfaces the diagnostic at the parameter's type clause. Such
        // diagnostics are produced during declaration binding, so they
        // live on the global-scope diagnostic bag rather than per-body.
        let source = `@Obsolete("legacy")
data struct Old {
    var Value int32
}

func Consume(o Old) {
}`
        let globalScope = BindSource(source)
        Assert.Contains(
            GetBinderDiagnostics(globalScope),
            (d Diagnostic) -> d.Id == "GS0204" && d.Message.Contains("Old") && d.Message.Contains("legacy")
        )
    }

    @Fact
    func Obsolete_Warning_Is_Reported_At_Interface_Type_Reference() {
        // #175: extend GS0204 to interface type references.
        let source = `@Obsolete
interface IOld {
}

func Consume(o IOld) {
}`
        let globalScope = BindSource(source)
        Assert.Contains(
            GetBinderDiagnostics(globalScope),
            (d Diagnostic) -> d.Id == "GS0204" && d.Message.Contains("IOld")
        )
    }

    @Fact
    func Obsolete_Warning_Is_Reported_At_Enum_Type_Reference() {
        // #175: extend GS0204 to enum type references.
        let source = `@Obsolete
enum Mode { A, B }

func Pick(m Mode) {
}`
        let globalScope = BindSource(source)
        Assert.Contains(
            GetBinderDiagnostics(globalScope),
            (d Diagnostic) -> d.Id == "GS0204" && d.Message.Contains("Mode")
        )
    }

    @Fact
    func Obsolete_On_Parameter_Reports_GS0209() {
        // Issue #177: `[Obsolete]`'s [AttributeUsage] excludes Parameter,
        // so applying `@Obsolete` to a parameter is rejected at the
        // declaration site (and never propagates to the parameter's
        // attribute list, so the #175 GS0204 use-site warning cannot
        // fire on the parameter).
        let source = `func Foo(@Obsolete("dead") x int32) int32 {
    return x + 1
}`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0209")
        let program = Binder.BindProgram(globalScope)
        Assert.DoesNotContain(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
    }

    @Fact
    func Obsolete_With_IsError_On_Class_Promotes_To_Error() {
        let source = `@Obsolete("gone", true)
class Old (value int32) {
}

func Main() {
    let x = Old(5)
}`
        let program = BindProgramFromSource(source)
        let diag = Assert.Single(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
        Assert.Equal(DiagnosticSeverity.Error, diag.Severity)
    }

    @Fact
    func Attaches_Attributes_To_Global_Variable_Symbol() {
        // Issue #187: a top-level `var`/`let`/`const` accepts annotations
        // (default target `field`). Verify the attributes flow onto the
        // GlobalVariableSymbol regardless of whether an accessibility
        // modifier is present.
        let source = `@Obsolete("retired")
let limit = 10

@Obsolete
public var counter = 0`
        let globalScope = BindSource(source)
        Assert.Empty(GetBinderDiagnostics(globalScope))
        let limit = globalScope.Variables.Single((v VariableSymbol) -> v.Name == "limit")
        let counter = globalScope.Variables.Single((v VariableSymbol) -> v.Name == "counter")
        Assert.Single(limit.Attributes)
        Assert.Equal("System.ObsoleteAttribute", limit.Attributes[0].AttributeType.Name)
        Assert.Equal(AttributeTargetKind.Field, limit.Attributes[0].Target)
        Assert.Single(counter.Attributes)
        Assert.Equal(AttributeTargetKind.Field, counter.Attributes[0].Target)
    }

    @Fact
    func Attaches_Attributes_To_Local_Variable_Symbol_For_Use_Site_Diagnostics() {
        // Issue #187: locals also accept annotations; the binder must
        // populate the LocalVariableSymbol.Attributes slot so #175 use-site
        // diagnostics fire on subsequent reads / writes.
        let source = `func Main() {
    @Obsolete("dead local")
    let x = 1
    let y = x + 1
    _ = y
}`
        let program = BindProgramFromSource(source)
        let diag = Assert.Single(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
        Assert.Equal(DiagnosticSeverity.Warning, diag.Severity)
        Assert.Contains("x", diag.Message)
        Assert.Contains("dead local", diag.Message)
    }

    @Fact
    func Obsolete_Warning_Fires_On_Global_Variable_Read_And_Write() {
        // Issue #187 + #175: every read or write of an `@Obsolete` global
        // surfaces GS0204.
        let source = `@Obsolete("dead global")
var counter = 0

func Main() {
    counter = counter + 1
}`
        let program = BindProgramFromSource(source)
        let obsoleteDiags = program.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0204").ToList()
        Assert.Equal(2, obsoleteDiags.Count)
        Assert.All(obsoleteDiags, (d Diagnostic) -> Assert.Contains("counter", d.Message))
        Assert.All(obsoleteDiags, (d Diagnostic) -> Assert.Contains("dead global", d.Message))
    }

    @Fact
    func Reports_Invalid_Use_Site_Target_On_Variable() {
        // `@method:` is not a valid target on a variable declaration.
        let source = "@method:Obsolete\nlet x = 1"
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0201")
    }

    @Fact
    func Reports_Annotations_Not_Allowed_On_Non_Variable_Statement() {
        // Issue #187: an `@` lead-in on a statement that is not a variable
        // declaration surfaces GS0206.
        let source = `func Main() {
    @Obsolete
    return
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0206")
    }

    @Fact
    func Attaches_Attributes_To_Enum_Member_Symbol() {
        // Issue #188: enum-member annotations (default target `field`) flow
        // onto the EnumMemberSymbol so #175 use-site diagnostics fire on
        // `Color.Red` references.
        let source = `enum Color {
    @Obsolete("retired")
    Red,
    Green,
    Blue,
}`
        let globalScope = BindSource(source)
        Assert.Empty(GetBinderDiagnostics(globalScope))
        let color = cast[EnumSymbol](globalScope.TypeAliases["Color"])
        let red = color.Members.Single((m EnumMemberSymbol) -> m.Name == "Red")
        let green = color.Members.Single((m EnumMemberSymbol) -> m.Name == "Green")
        Assert.Single(red.Attributes)
        Assert.Equal("System.ObsoleteAttribute", red.Attributes[0].AttributeType.Name)
        Assert.Equal(AttributeTargetKind.Field, red.Attributes[0].Target)
        Assert.Empty(green.Attributes)
    }

    @Fact
    func Obsolete_Warning_Fires_On_Enum_Member_Reference() {
        // Issue #188: every read of an `@Obsolete` enum member surfaces
        // GS0204 at the member-identifier location.
        let source = `enum Color {
    @Obsolete("use Crimson instead")
    Red,
    Green,
}

func Main() {
    let c = Color.Red
    _ = c
}`
        let program = BindProgramFromSource(source)
        let diag = Assert.Single(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
        Assert.Equal(DiagnosticSeverity.Warning, diag.Severity)
        Assert.Contains("Color.Red", diag.Message)
        Assert.Contains("use Crimson instead", diag.Message)
    }

    @Fact
    func Obsolete_With_IsError_On_Enum_Member_Promotes_To_Error() {
        // Issue #188: `@Obsolete("gone", true)` on an enum member promotes
        // the use-site GS0204 to an error.
        let source = `enum Color {
    @Obsolete("gone", true)
    Red,
    Green,
}

func Main() {
    let c = Color.Red
    _ = c
}`
        let program = BindProgramFromSource(source)
        let diag = Assert.Single(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
        Assert.Equal(DiagnosticSeverity.Error, diag.Severity)
    }

    @Fact
    func Reports_Invalid_Use_Site_Target_On_Enum_Member() {
        // `@method:` is not a valid target on an enum-member declaration.
        let source = `enum Color {
    @method:Obsolete
    Red,
    Green,
}`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0201")
    }

    @Fact
    func Attaches_Attributes_To_Struct_Field_Symbol() {
        // Issue #186: field-declaration annotations (default target `field`)
        // flow onto the FieldSymbol so #175 use-site diagnostics fire on
        // `p.Old` reads and writes.
        let source = `data struct Point {
    @Obsolete("retired")
    var X int32
    var Y int32
}`
        let globalScope = BindSource(source)
        Assert.Empty(GetBinderDiagnostics(globalScope))
        let point = cast[StructSymbol](globalScope.TypeAliases["Point"])
        let x = point.Fields.Single((f FieldSymbol) -> f.Name == "X")
        let y = point.Fields.Single((f FieldSymbol) -> f.Name == "Y")
        Assert.Single(x.Attributes)
        Assert.Equal("System.ObsoleteAttribute", x.Attributes[0].AttributeType.Name)
        Assert.Equal(AttributeTargetKind.Field, x.Attributes[0].Target)
        Assert.Empty(y.Attributes)
    }

    @Fact
    func Obsolete_Warning_Fires_On_Struct_Field_Read() {
        // Issue #186: reading an obsolete field via `p.X` surfaces GS0204
        // at the field-identifier location.
        let source = `data struct Point {
    @Obsolete("use NewX")
    var X int32
    var Y int32
}

func Main() {
    let p = Point{ X: 1, Y: 2 }
    _ = p.X
}`
        let program = BindProgramFromSource(source)
        let diag = Assert.Single(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
        Assert.Equal(DiagnosticSeverity.Warning, diag.Severity)
        Assert.Contains("Point.X", diag.Message)
        Assert.Contains("use NewX", diag.Message)
    }

    @Fact
    func Obsolete_Warning_Fires_On_Struct_Field_Write() {
        // Issue #186: writing an obsolete field via `p.X = ...` surfaces
        // GS0204 at the field-identifier location.
        let source = `struct Point {
    @Obsolete("use NewX")
    var X int32
}

func Main() {
    var p = Point{ X: 1 }
    p.X = 5
}`
        let program = BindProgramFromSource(source)
        let diag = Assert.Single(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
        Assert.Equal(DiagnosticSeverity.Warning, diag.Severity)
        Assert.Contains("Point.X", diag.Message)
    }

    @Fact
    func Obsolete_With_IsError_On_Struct_Field_Promotes_To_Error() {
        // Issue #186: `@Obsolete("gone", true)` on a field promotes the
        // use-site GS0204 to an error at the read site.
        let source = `data struct Point {
    @Obsolete("gone", true)
    var X int32
    var Y int32
}

func Main() {
    let p = Point{ X: 1, Y: 2 }
    _ = p.X
}`
        let program = BindProgramFromSource(source)
        let diag = Assert.Single(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204")
        Assert.Equal(DiagnosticSeverity.Error, diag.Severity)
    }

    @Fact
    func Reports_Invalid_Use_Site_Target_On_Struct_Field() {
        // `@method:` is not a valid target on a field declaration.
        let source = `data struct Point {
    @method:Obsolete
    var X int32
    var Y int32
}`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0201")
    }

    @Fact
    func Obsolete_Warning_Fires_On_Class_Field_Read_From_Method() {
        // Issue #186: bare field-name read inside a class method fires
        // GS0204 when the field carries `@Obsolete`.
        let source = `class Box {
    @Obsolete("use NewValue")
    var Value int32

    public func Get() int32 {
        return Value
    }
}`
        let program = BindProgramFromSource(source)
        Assert.Contains(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0204" && d.Message.Contains("Box.Value"))
    }

    @Fact
    func EnumeratorCancellation_On_CancellationToken_In_AsyncSequence_Is_Accepted() {
        // ADR-0040 / issue #180: a CancellationToken parameter on a function
        // returning IAsyncEnumerable[T] is the only valid place for the
        // attribute. No diagnostics should be reported.
        let source = `import System.Collections.Generic
import System.Runtime.CompilerServices
import System.Threading

func numbers(@EnumeratorCancellation ct CancellationToken) IAsyncEnumerable[int32] {
    yield 1
}`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0207")
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0208")
        let numbers = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "numbers")
        let ct = numbers.Parameters.Single()
        let attr = Assert.Single(ct.Attributes)
        Assert.Equal("System.Runtime.CompilerServices.EnumeratorCancellationAttribute", attr.AttributeType.Name)
    }

    @Fact
    func EnumeratorCancellation_On_NonToken_Parameter_Reports_GS0207() {
        // ADR-0040: ERR_EnumeratorCancellationWrongType — the attribute is
        // valid only on a CancellationToken parameter.
        let source = `import System.Collections.Generic
import System.Runtime.CompilerServices

func numbers(@EnumeratorCancellation n int32) IAsyncEnumerable[int32] {
    yield n
}`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0207")
    }

    @Fact
    func EnumeratorCancellation_On_NonAsyncSequence_Reports_GS0208() {
        // ADR-0040: the runtime threads the per-enumerator token only through
        // IAsyncEnumerable.GetAsyncEnumerator, so applying the attribute on a
        // plain function (or an iterator/enumerator return) is an error.
        let source = `import System.Threading
import System.Runtime.CompilerServices

func noop(@EnumeratorCancellation ct CancellationToken) {
}`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0208")
    }

    @Fact
    func EnumeratorCancellation_On_AsyncEnumerator_Return_Reports_GS0208() {
        // IAsyncEnumerator[T] is *not* an `async sequence` — it has no
        // GetAsyncEnumerator(CancellationToken) overload to thread the token
        // through, so the attribute is rejected.
        let source = `import System.Collections.Generic
import System.Runtime.CompilerServices
import System.Threading

func numbers(@EnumeratorCancellation ct CancellationToken) IAsyncEnumerator[int32] {
    yield 1
}`
        let globalScope = BindSource(source)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0208")
    }

    @Fact
    func AttributeUsage_Obsolete_On_Parameter_Reports_GS0209() {
        // Issue #177: `[Obsolete]`'s [AttributeUsage] does NOT include
        // AttributeTargets.Parameter, so applying `@Obsolete` to a parameter
        // must be rejected.
        let source = `import System

func Foo(@Obsolete("x") name string) {
}`
        let globalScope = BindSource(source)
        Assert.Contains(
            GetBinderDiagnostics(globalScope),
            (d Diagnostic) -> d.Id == "GS0209" && d.Message.Contains("Obsolete")
        )
    }

    @Fact
    func AttributeUsage_Obsolete_On_Return_Reports_GS0209() {
        // Issue #177: `[Obsolete]`'s [AttributeUsage] excludes
        // AttributeTargets.ReturnValue, so `@return:Obsolete` is rejected.
        let source = `import System

@return:Obsolete("x")
func Foo() int32 {
    return 0
}`
        let globalScope = BindSource(source)
        Assert.Contains(
            GetBinderDiagnostics(globalScope),
            (d Diagnostic) -> d.Id == "GS0209" && d.Message.Contains("Obsolete")
        )
    }

    @Fact
    func AttributeUsage_DuplicateObsolete_On_Function_Reports_GS0210() {
        // Issue #177: `[Obsolete]`'s [AttributeUsage(AllowMultiple = false)]
        // — applying it twice to the same declaration is an error.
        let source = `@Obsolete("first")
@Obsolete("second")
func Foo() {
}`
        let globalScope = BindSource(source)
        Assert.Contains(
            GetBinderDiagnostics(globalScope),
            (d Diagnostic) -> d.Id == "GS0210" && d.Message.Contains("Obsolete")
        )
    }

    @Fact
    func AttributeUsage_AllowMultiple_True_Permits_Duplicates() {
        // Issue #177: `[Conditional]` carries
        // `[AttributeUsage(Method, AllowMultiple = true)]`, so two
        // applications on the same method must NOT report GS0210.
        let source = `import System.Diagnostics

@Conditional("DEBUG")
@Conditional("TRACE")
func Log() {
}`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0210")
    }

    @Fact
    func AttributeUsage_UserAttribute_With_ValidOn_Method_On_Field_Reports_GS0209() {
        // Issue #177: a user-declared `@Attribute` class whose
        // `@AttributeUsage(AttributeTargets.Method)` excludes Field must be
        // rejected when applied to a field.
        let source = `import System

@Attribute
@AttributeUsage(AttributeTargets.Method)
class MethodOnly {
}

class Box {
    @MethodOnly
    var Value int32
}`
        let globalScope = BindSource(source)
        Assert.Contains(
            GetBinderDiagnostics(globalScope),
            (d Diagnostic) -> d.Id == "GS0209" && d.Message.Contains("MethodOnly")
        )
    }

    @Fact
    func AttributeUsage_UserAttribute_AllowMultiple_True_Permits_Duplicates() {
        // Issue #177: a user-declared `@Attribute` class whose
        // `@AttributeUsage(All, AllowMultiple: true)` opts into multiple
        // applications — two applications must NOT report GS0210.
        let source = `import System

@Attribute
@AttributeUsage(AttributeTargets.All, AllowMultiple: true)
class Tag {
}

@Tag
@Tag
func Foo() {
}`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0210")
    }

    @Fact
    func AttributeArgument_EnumFlagsOr_IsFoldedAsConstant() {
        // Issue #3684 (family F11): `AttributeTargets.Method |
        // AttributeTargets.Class` is a compile-time constant per ECMA-335
        // II.23.3 (the blob carries the folded underlying primitive), but it
        // parses as a binary expression and so missed the enum-literal
        // fallthrough in TryBindAttributeArgument — GS0202.
        let source = `import System

@Attribute
@AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, AllowMultiple: true, Inherited: true)
class Marker {
}

@Marker
func Foo() {
}

@Marker
class Boxed {
}`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0202")
        // The folded ValidOn must actually cover BOTH targets — a fold that
        // silently kept only the first operand would report GS0209 on one of
        // the two applications.
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0209")
    }

    @Fact
    func AttributeArgument_ArrayOfTypeOfSameCompilationType_IsFoldedAsConstant() {
        // Issue #3684 (family F11): a 1-D array of `typeof` is explicitly
        // legal, but an element naming a type declared in THIS compilation has
        // no CLR `Type` yet — the binder hands back the `TypeSymbol`
        // placeholder, which a `Type[]` container could not hold, so
        // `Array.SetValue` threw and the whole argument was rejected (GS0202).
        let source = `import System

class Generators {
}

@Attribute
@AttributeUsage(AttributeTargets.All)
class ArbitraryAttribute {
}

@Arbitrary([]Type{typeof(Generators), typeof(string)})
func Foo() {
}`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0202")
    }

    @Fact
    func Conditional_On_Non_Void_Function_Reports_GS0212() {
        // Issue #176 / ADR-0047 §6: `[Conditional]` requires a void return
        // type because the call may be elided at the call site.
        let source = `import System.Diagnostics

@Conditional("DEBUG")
func DebugLog() int32 {
    return 1
}`
        let globalScope = BindSource(source)
        let diag = Assert.Single(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0212")
        Assert.Contains("DebugLog", diag.Message)
        Assert.Equal(DiagnosticSeverity.Error, diag.Severity)
    }

    @Fact
    func Conditional_On_Void_Function_Does_Not_Report_GS0212() {
        let source = `import System.Diagnostics

@Conditional("DEBUG")
func DebugLog() {
}`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0212")
        let trace = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "DebugLog")
        Assert.Single(trace.Attributes)
        Assert.Equal("System.Diagnostics.ConditionalAttribute", trace.Attributes[0].AttributeType.Name)
    }

    @Fact
    func Conditional_Call_Is_Elided_When_Symbol_Not_Defined() {
        // Issue #176 / ADR-0047 §6: when no preprocessor symbol matches any
        // of the function's `[Conditional("SYMBOL")]` applications, the call
        // is replaced by a no-op and argument evaluation is suppressed.
        let source = `import System.Diagnostics

@Conditional("DEBUG")
func DebugLog(message string) {
}

func Main() {
    DebugLog("hello")
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        let program = Binder.BindProgram(globalScope)
        let main = program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "Main" && f.Declaration != nil)
        let call = FindCalls(program.Functions[main]).Single()
        Assert.True(call.IsConditionalElided)
        Assert.Empty(call.Arguments)
    }

    @Fact
    func Conditional_Call_Is_Kept_When_Symbol_Defined() {
        let source = `import System.Diagnostics

@Conditional("DEBUG")
func DebugLog(message string) {
}

func Main() {
    DebugLog("hello")
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let preprocessorSymbols = ImmutableHashSet.Create("DEBUG")
        let globalScope = Binder.BindGlobalScope(
            previous: nil,
            ImmutableArray.Create(tree),
            references: nil,
            implicitSystemImport: true,
            preprocessorSymbols
        )
        let program = Binder.BindProgram(globalScope)
        let main = program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "Main")
        let call = FindCalls(program.Functions[main]).Single()
        Assert.False(call.IsConditionalElided)
        Assert.Single(call.Arguments)
    }

    @Fact
    func Conditional_Call_Is_Kept_When_Any_Of_Multiple_Symbols_Defined() {
        // Issue #176 / ADR-0047 §6 / C# CS0578 semantics: multiple
        // `[Conditional]` applications are combined disjunctively — the call
        // is emitted if *any* named symbol is defined.
        let source = `import System.Diagnostics

@Conditional("DEBUG")
@Conditional("TRACE")
func DebugLog() {
}

func Main() {
    DebugLog()
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let preprocessorSymbols = ImmutableHashSet.Create("TRACE")
        let globalScope = Binder.BindGlobalScope(
            previous: nil,
            ImmutableArray.Create(tree),
            references: nil,
            implicitSystemImport: true,
            preprocessorSymbols
        )
        let program = Binder.BindProgram(globalScope)
        let main = program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "Main")
        let call = FindCalls(program.Functions[main]).Single()
        Assert.False(call.IsConditionalElided)
    }

    @Fact
    func Conditional_Call_Is_Elided_When_None_Of_Multiple_Symbols_Defined() {
        let source = `import System.Diagnostics

@Conditional("DEBUG")
@Conditional("TRACE")
func DebugLog() {
}

func Main() {
    DebugLog()
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let preprocessorSymbols = ImmutableHashSet.Create("PROFILE")
        let globalScope = Binder.BindGlobalScope(
            previous: nil,
            ImmutableArray.Create(tree),
            references: nil,
            implicitSystemImport: true,
            preprocessorSymbols
        )
        let program = Binder.BindProgram(globalScope)
        let main = program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "Main")
        let call = FindCalls(program.Functions[main]).Single()
        Assert.True(call.IsConditionalElided)
    }

    private class CallCollector : BoundTreeRewriter {
        init() {
            Calls = List[BoundCallExpression]()
        }

        prop Calls List[BoundCallExpression] {
            get;
        }

        protected override func RewriteCallExpression(node BoundCallExpression) BoundExpression {
            Calls.Add(node)
            return base.RewriteCallExpression(node)
        }
    }

    shared {
        private func FindCalls(node BoundStatement) IEnumerable[BoundCallExpression] {
            let collector = AttributeBinderTests.CallCollector()
            collector.RewriteStatement(node)
            return collector.Calls
        }

        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func BindProgramFromSource(source string) BoundProgram {
            return Binder.BindProgram(BindSource(source))
        }

        private func GetBinderDiagnostics($scope BoundGlobalScope) IEnumerable[Diagnostic] {
            return $scope.Diagnostics
        }
    }
}
