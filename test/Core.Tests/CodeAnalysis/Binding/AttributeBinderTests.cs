// <copyright file="AttributeBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Tests for ADR-0047 Phase 2 attribute binding: name resolution against the
/// declaring scope, use-site target validation, and compile-time constant
/// argument checking. Annotations on type aliases and parameters are bound
/// for diagnostics; the bound-attribute list itself is asserted via the
/// owning <see cref="GSharp.Core.CodeAnalysis.Symbols.Symbol.Attributes"/>
/// slot for functions, structs, and interfaces.
/// </summary>
public class AttributeBinderTests
{
    [Fact]
    public void Resolves_Obsolete_With_Attribute_Suffix()
    {
        // `@Obsolete` resolves to System.ObsoleteAttribute via the suffix rule.
        var globalScope = BindSource("@Obsolete\nfunc Helper() {\n}\n");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");

        Assert.Single(helper.Attributes);
        Assert.Equal("System.ObsoleteAttribute", helper.Attributes[0].AttributeType.Name);
        Assert.Equal(AttributeTargetKind.Method, helper.Attributes[0].Target);
        Assert.Empty(GetBinderDiagnostics(globalScope));
    }

    [Fact]
    public void Resolves_Obsolete_With_Message_Argument()
    {
        var globalScope = BindSource("@Obsolete(\"use Bar instead\")\nfunc Foo() {\n}\n");
        var foo = globalScope.Functions.Single(f => f.Name == "Foo");

        var attr = Assert.Single(foo.Attributes);
        var posArg = Assert.Single(attr.PositionalArguments);
        Assert.Equal("use Bar instead", posArg.Value);
        Assert.Empty(GetBinderDiagnostics(globalScope));
    }

    [Fact]
    public void Reports_Unknown_Attribute_Type()
    {
        var globalScope = BindSource("@DoesNotExistAnywhere\nfunc Helper() {\n}\n");

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0198");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");
        Assert.Empty(helper.Attributes);
    }

    [Fact]
    public void Reports_When_Type_Is_Not_An_Attribute()
    {
        // `int` resolves but is not a System.Attribute subclass — must report GS0200.
        var globalScope = BindSource("@int\nfunc Helper() {\n}\n");

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0200");
    }

    [Fact]
    public void Reports_Invalid_Use_Site_Target_On_Function()
    {
        // `@field:` is not valid on a function declaration.
        var globalScope = BindSource("@field:Obsolete\nfunc Helper() {\n}\n");

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0201");
    }

    [Fact]
    public void Allows_Return_Use_Site_Target_On_Function()
    {
        var globalScope = BindSource("@return:Obsolete\nfunc Helper() {\n}\n");

        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), d => d.Id == "GS0201");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");
        var attr = Assert.Single(helper.Attributes);
        Assert.Equal(AttributeTargetKind.Return, attr.Target);
    }

    [Fact]
    public void Reports_Non_Constant_Attribute_Argument()
    {
        // A nameof(...) expression isn't a recognised literal-shaped constant
        // for v1 — it must report GS0202.
        var globalScope = BindSource("@Obsolete(nameof(Helper))\nfunc Helper() {\n}\n");

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0202");
    }

    [Fact]
    public void Attaches_Attributes_To_Struct_Symbol()
    {
        var source = @"
@Obsolete
type Point struct {
    X int
    Y int
}
";
        var globalScope = BindSource(source);
        var point = globalScope.Structs.Single(t => t.Name == "Point");

        Assert.Single(point.Attributes);
        Assert.Equal(AttributeTargetKind.Type, point.Attributes[0].Target);
    }

    [Fact]
    public void Reports_Invalid_Use_Site_Target_On_Struct()
    {
        var source = @"
@method:Obsolete
type Point struct {
    X int
}
";
        var globalScope = BindSource(source);

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0201");
    }

    [Fact]
    public void Binds_Multiple_Stacked_Annotations()
    {
        var globalScope = BindSource("@Obsolete\n@Obsolete(\"again\")\nfunc Helper() {\n}\n");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");

        Assert.Equal(2, helper.Attributes.Length);
    }

    [Fact]
    public void AttributeSugar_Marks_Class_As_AttributeClass_And_Does_Not_Emit_Marker_Attribute()
    {
        var source = """
            package P
            import System

            @Attribute
            type Trace class {
            }
            """;

        var globalScope = BindSource(source);
        var trace = globalScope.Structs.Single(s => s.Name == "Trace");

        Assert.True(trace.IsAttributeClass);

        // The @Attribute marker is sugar — it must NOT appear in Symbol.Attributes
        // (since System.Attribute is not itself an applicable attribute).
        Assert.Empty(trace.Attributes);
        Assert.Empty(GetBinderDiagnostics(globalScope));
    }

    [Fact]
    public void AttributeSugar_Tolerates_Explicit_System_Attribute_Base()
    {
        var source = """
            package P
            import System

            @Attribute
            type Trace class : Attribute {
            }
            """;

        var globalScope = BindSource(source);
        var trace = globalScope.Structs.Single(s => s.Name == "Trace");

        Assert.True(trace.IsAttributeClass);
        Assert.Empty(GetBinderDiagnostics(globalScope));
    }

    [Fact]
    public void AttributeSugar_Reports_Conflict_With_Other_Explicit_Base()
    {
        var source = """
            package P
            import System

            open type Other class {
            }

            @Attribute
            type Trace class : Other {
            }
            """;

        var globalScope = BindSource(source);

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0203");
    }

    [Fact]
    public void Obsolete_Warning_Is_Reported_At_Call_Site()
    {
        var source = """
            @Obsolete("use Bar")
            func Old() {
            }

            func Main() {
                Old()
            }
            """;

        var program = BindProgramFromSource(source);
        var diags = program.Diagnostics.Where(d => d.Id == "GS0204").ToList();

        var obsoleteDiag = Assert.Single(diags);
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning, obsoleteDiag.Severity);
        Assert.Contains("Old", obsoleteDiag.Message);
        Assert.Contains("use Bar", obsoleteDiag.Message);
    }

    [Fact]
    public void Obsolete_With_IsError_Promotes_To_Error()
    {
        var source = """
            @Obsolete("dead", true)
            func Old() {
            }

            func Main() {
                Old()
            }
            """;

        var program = BindProgramFromSource(source);
        var obsoleteDiag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error, obsoleteDiag.Severity);
    }

    [Fact]
    public void Reserved_CompilerGenerated_Attribute_Is_Rejected()
    {
        var source = """
            import System.Runtime.CompilerServices

            @CompilerGenerated
            func Helper() {
            }
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0205");

        var helper = globalScope.Functions.Single(f => f.Name == "Helper");
        Assert.Empty(helper.Attributes);
    }

    [Fact]
    public void Reserved_Extension_Attribute_Is_Rejected()
    {
        var source = """
            import System.Runtime.CompilerServices

            @Extension
            func Helper() {
            }
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0205");
    }

    [Fact]
    public void Obsolete_Warning_Is_Reported_At_Class_Constructor_Call()
    {
        // #175: extend GS0204 to primary-constructor calls on classes.
        var source = """
            @Obsolete("retired")
            type Old class (value int) {
            }

            func Main() {
                let x = Old(5)
            }
            """;

        var program = BindProgramFromSource(source);
        var diag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning, diag.Severity);
        Assert.Contains("Old", diag.Message);
        Assert.Contains("retired", diag.Message);
    }

    [Fact]
    public void Obsolete_Warning_Is_Reported_At_Struct_Literal()
    {
        // #175: extend GS0204 to struct/class literal expressions.
        var source = """
            @Obsolete
            type Point data struct {
                X int
                Y int
            }

            func Main() {
                let p = Point{ X: 1, Y: 2 }
            }
            """;

        var program = BindProgramFromSource(source);
        var diag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning, diag.Severity);
        Assert.Contains("Point", diag.Message);
    }

    [Fact]
    public void Obsolete_Warning_Is_Reported_At_Type_Clause_Reference()
    {
        // #175: extend GS0204 to named type references in type position.
        // Marking a struct obsolete and naming it as a parameter type
        // surfaces the diagnostic at the parameter's type clause. Such
        // diagnostics are produced during declaration binding, so they
        // live on the global-scope diagnostic bag rather than per-body.
        var source = """
            @Obsolete("legacy")
            type Old data struct {
                Value int
            }

            func Consume(o Old) {
            }
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0204" && d.Message.Contains("Old") && d.Message.Contains("legacy"));
    }

    [Fact]
    public void Obsolete_Warning_Is_Reported_At_Interface_Type_Reference()
    {
        // #175: extend GS0204 to interface type references.
        var source = """
            @Obsolete
            type IOld interface {
            }

            func Consume(o IOld) {
            }
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0204" && d.Message.Contains("IOld"));
    }

    [Fact]
    public void Obsolete_Warning_Is_Reported_At_Enum_Type_Reference()
    {
        // #175: extend GS0204 to enum type references.
        var source = """
            @Obsolete
            type Mode enum { A, B }

            func Pick(m Mode) {
            }
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0204" && d.Message.Contains("Mode"));
    }

    [Fact]
    public void Obsolete_Warning_Is_Reported_At_Parameter_Use_Site()
    {
        // #175: parameters that carry @Obsolete surface GS0204 at every
        // read or write site (parameters already carry attribute storage
        // per #170).
        var source = """
            func Foo(@Obsolete("dead") x int) int {
                return x + 1
            }
            """;

        var program = BindProgramFromSource(source);
        var diag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning, diag.Severity);
        Assert.Contains("x", diag.Message);
        Assert.Contains("dead", diag.Message);
    }

    [Fact]
    public void Obsolete_With_IsError_On_Class_Promotes_To_Error()
    {
        var source = """
            @Obsolete("gone", true)
            type Old class (value int) {
            }

            func Main() {
                let x = Old(5)
            }
            """;

        var program = BindProgramFromSource(source);
        var diag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error, diag.Severity);
    }

    [Fact]
    public void Attaches_Attributes_To_Global_Variable_Symbol()
    {
        // Issue #187: a top-level `var`/`let`/`const` accepts annotations
        // (default target `field`). Verify the attributes flow onto the
        // GlobalVariableSymbol regardless of whether an accessibility
        // modifier is present.
        var source = """
            @Obsolete("retired")
            let limit = 10

            @Obsolete
            public var counter = 0
            """;

        var globalScope = BindSource(source);
        Assert.Empty(GetBinderDiagnostics(globalScope));

        var limit = globalScope.Variables.Single(v => v.Name == "limit");
        var counter = globalScope.Variables.Single(v => v.Name == "counter");

        Assert.Single(limit.Attributes);
        Assert.Equal("System.ObsoleteAttribute", limit.Attributes[0].AttributeType.Name);
        Assert.Equal(AttributeTargetKind.Field, limit.Attributes[0].Target);

        Assert.Single(counter.Attributes);
        Assert.Equal(AttributeTargetKind.Field, counter.Attributes[0].Target);
    }

    [Fact]
    public void Attaches_Attributes_To_Local_Variable_Symbol_For_Use_Site_Diagnostics()
    {
        // Issue #187: locals also accept annotations; the binder must
        // populate the LocalVariableSymbol.Attributes slot so #175 use-site
        // diagnostics fire on subsequent reads / writes.
        var source = """
            func Main() {
                @Obsolete("dead local")
                let x = 1
                let y = x + 1
                _ = y
            }
            """;

        var program = BindProgramFromSource(source);
        var diag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning, diag.Severity);
        Assert.Contains("x", diag.Message);
        Assert.Contains("dead local", diag.Message);
    }

    [Fact]
    public void Obsolete_Warning_Fires_On_Global_Variable_Read_And_Write()
    {
        // Issue #187 + #175: every read or write of an `@Obsolete` global
        // surfaces GS0204.
        var source = """
            @Obsolete("dead global")
            var counter = 0

            func Main() {
                counter = counter + 1
            }
            """;

        var program = BindProgramFromSource(source);
        var obsoleteDiags = program.Diagnostics.Where(d => d.Id == "GS0204").ToList();
        Assert.Equal(2, obsoleteDiags.Count);
        Assert.All(obsoleteDiags, d => Assert.Contains("counter", d.Message));
        Assert.All(obsoleteDiags, d => Assert.Contains("dead global", d.Message));
    }

    [Fact]
    public void Reports_Invalid_Use_Site_Target_On_Variable()
    {
        // `@method:` is not a valid target on a variable declaration.
        var source = """
            @method:Obsolete
            let x = 1
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0201");
    }

    [Fact]
    public void Reports_Annotations_Not_Allowed_On_Non_Variable_Statement()
    {
        // Issue #187: an `@` lead-in on a statement that is not a variable
        // declaration surfaces GS0206.
        var source = """
            func Main() {
                @Obsolete
                return
            }
            """;

        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0206");
    }

    [Fact]
    public void Attaches_Attributes_To_Enum_Member_Symbol()
    {
        // Issue #188: enum-member annotations (default target `field`) flow
        // onto the EnumMemberSymbol so #175 use-site diagnostics fire on
        // `Color.Red` references.
        var source = """
            type Color enum {
                @Obsolete("retired")
                Red,
                Green,
                Blue,
            }
            """;

        var globalScope = BindSource(source);
        Assert.Empty(GetBinderDiagnostics(globalScope));

        var color = (GSharp.Core.CodeAnalysis.Symbols.EnumSymbol)globalScope.TypeAliases["Color"];
        var red = color.Members.Single(m => m.Name == "Red");
        var green = color.Members.Single(m => m.Name == "Green");

        Assert.Single(red.Attributes);
        Assert.Equal("System.ObsoleteAttribute", red.Attributes[0].AttributeType.Name);
        Assert.Equal(AttributeTargetKind.Field, red.Attributes[0].Target);
        Assert.Empty(green.Attributes);
    }

    [Fact]
    public void Obsolete_Warning_Fires_On_Enum_Member_Reference()
    {
        // Issue #188: every read of an `@Obsolete` enum member surfaces
        // GS0204 at the member-identifier location.
        var source = """
            type Color enum {
                @Obsolete("use Crimson instead")
                Red,
                Green,
            }

            func Main() {
                let c = Color.Red
                _ = c
            }
            """;

        var program = BindProgramFromSource(source);
        var diag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning, diag.Severity);
        Assert.Contains("Color.Red", diag.Message);
        Assert.Contains("use Crimson instead", diag.Message);
    }

    [Fact]
    public void Obsolete_With_IsError_On_Enum_Member_Promotes_To_Error()
    {
        // Issue #188: `@Obsolete("gone", true)` on an enum member promotes
        // the use-site GS0204 to an error.
        var source = """
            type Color enum {
                @Obsolete("gone", true)
                Red,
                Green,
            }

            func Main() {
                let c = Color.Red
                _ = c
            }
            """;

        var program = BindProgramFromSource(source);
        var diag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error, diag.Severity);
    }

    [Fact]
    public void Reports_Invalid_Use_Site_Target_On_Enum_Member()
    {
        // `@method:` is not a valid target on an enum-member declaration.
        var source = """
            type Color enum {
                @method:Obsolete
                Red,
                Green,
            }
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0201");
    }

    [Fact]
    public void Attaches_Attributes_To_Struct_Field_Symbol()
    {
        // Issue #186: field-declaration annotations (default target `field`)
        // flow onto the FieldSymbol so #175 use-site diagnostics fire on
        // `p.Old` reads and writes.
        var source = """
            type Point data struct {
                @Obsolete("retired")
                X int
                Y int
            }
            """;

        var globalScope = BindSource(source);
        Assert.Empty(GetBinderDiagnostics(globalScope));

        var point = (GSharp.Core.CodeAnalysis.Symbols.StructSymbol)globalScope.TypeAliases["Point"];
        var x = point.Fields.Single(f => f.Name == "X");
        var y = point.Fields.Single(f => f.Name == "Y");

        Assert.Single(x.Attributes);
        Assert.Equal("System.ObsoleteAttribute", x.Attributes[0].AttributeType.Name);
        Assert.Equal(AttributeTargetKind.Field, x.Attributes[0].Target);
        Assert.Empty(y.Attributes);
    }

    [Fact]
    public void Obsolete_Warning_Fires_On_Struct_Field_Read()
    {
        // Issue #186: reading an obsolete field via `p.X` surfaces GS0204
        // at the field-identifier location.
        var source = """
            type Point data struct {
                @Obsolete("use NewX")
                X int
                Y int
            }

            func Main() {
                let p = Point{ X: 1, Y: 2 }
                _ = p.X
            }
            """;

        var program = BindProgramFromSource(source);
        var diag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning, diag.Severity);
        Assert.Contains("Point.X", diag.Message);
        Assert.Contains("use NewX", diag.Message);
    }

    [Fact]
    public void Obsolete_Warning_Fires_On_Struct_Field_Write()
    {
        // Issue #186: writing an obsolete field via `p.X = ...` surfaces
        // GS0204 at the field-identifier location.
        var source = """
            type Point struct {
                @Obsolete("use NewX")
                X int
            }

            func Main() {
                var p = Point{ X: 1 }
                p.X = 5
            }
            """;

        var program = BindProgramFromSource(source);
        var diag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning, diag.Severity);
        Assert.Contains("Point.X", diag.Message);
    }

    [Fact]
    public void Obsolete_With_IsError_On_Struct_Field_Promotes_To_Error()
    {
        // Issue #186: `@Obsolete("gone", true)` on a field promotes the
        // use-site GS0204 to an error at the read site.
        var source = """
            type Point data struct {
                @Obsolete("gone", true)
                X int
                Y int
            }

            func Main() {
                let p = Point{ X: 1, Y: 2 }
                _ = p.X
            }
            """;

        var program = BindProgramFromSource(source);
        var diag = Assert.Single(program.Diagnostics, d => d.Id == "GS0204");
        Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error, diag.Severity);
    }

    [Fact]
    public void Reports_Invalid_Use_Site_Target_On_Struct_Field()
    {
        // `@method:` is not a valid target on a field declaration.
        var source = """
            type Point data struct {
                @method:Obsolete
                X int
                Y int
            }
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0201");
    }

    [Fact]
    public void Obsolete_Warning_Fires_On_Class_Field_Read_From_Method()
    {
        // Issue #186: bare field-name read inside a class method fires
        // GS0204 when the field carries `@Obsolete`.
        var source = """
            type Box class {
                @Obsolete("use NewValue")
                Value int

                public func Get() int {
                    return Value
                }
            }
            """;

        var program = BindProgramFromSource(source);
        Assert.Contains(program.Diagnostics, d => d.Id == "GS0204" && d.Message.Contains("Box.Value"));
    }

    [Fact]
    public void EnumeratorCancellation_On_CancellationToken_In_AsyncSequence_Is_Accepted()
    {
        // ADR-0040 / issue #180: a CancellationToken parameter on a function
        // returning IAsyncEnumerable[T] is the only valid place for the
        // attribute. No diagnostics should be reported.
        var source = """
            import System.Collections.Generic
            import System.Runtime.CompilerServices
            import System.Threading

            func numbers(@EnumeratorCancellation ct CancellationToken) IAsyncEnumerable[int] {
                yield 1
            }
            """;

        var globalScope = BindSource(source);
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), d => d.Id == "GS0207");
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), d => d.Id == "GS0208");

        var numbers = globalScope.Functions.Single(f => f.Name == "numbers");
        var ct = numbers.Parameters.Single();
        var attr = Assert.Single(ct.Attributes);
        Assert.Equal(
            "System.Runtime.CompilerServices.EnumeratorCancellationAttribute",
            attr.AttributeType.Name);
    }

    [Fact]
    public void EnumeratorCancellation_On_NonToken_Parameter_Reports_GS0207()
    {
        // ADR-0040: ERR_EnumeratorCancellationWrongType — the attribute is
        // valid only on a CancellationToken parameter.
        var source = """
            import System.Collections.Generic
            import System.Runtime.CompilerServices

            func numbers(@EnumeratorCancellation n int) IAsyncEnumerable[int] {
                yield n
            }
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0207");
    }

    [Fact]
    public void EnumeratorCancellation_On_NonAsyncSequence_Reports_GS0208()
    {
        // ADR-0040: the runtime threads the per-enumerator token only through
        // IAsyncEnumerable.GetAsyncEnumerator, so applying the attribute on a
        // plain function (or an iterator/enumerator return) is an error.
        var source = """
            import System.Threading
            import System.Runtime.CompilerServices

            func noop(@EnumeratorCancellation ct CancellationToken) {
            }
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0208");
    }

    [Fact]
    public void EnumeratorCancellation_On_AsyncEnumerator_Return_Reports_GS0208()
    {
        // IAsyncEnumerator[T] is *not* an `async sequence` — it has no
        // GetAsyncEnumerator(CancellationToken) overload to thread the token
        // through, so the attribute is rejected.
        var source = """
            import System.Collections.Generic
            import System.Runtime.CompilerServices
            import System.Threading

            func numbers(@EnumeratorCancellation ct CancellationToken) IAsyncEnumerator[int] {
                yield 1
            }
            """;

        var globalScope = BindSource(source);
        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0208");
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static BoundProgram BindProgramFromSource(string source)
    {
        return Binder.BindProgram(BindSource(source));
    }

    private static System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> GetBinderDiagnostics(BoundGlobalScope scope)
    {
        return scope.Diagnostics;
    }
}
