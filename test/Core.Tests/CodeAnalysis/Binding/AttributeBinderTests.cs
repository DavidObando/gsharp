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
