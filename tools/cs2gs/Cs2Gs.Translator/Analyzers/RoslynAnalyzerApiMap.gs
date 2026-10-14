// <copyright file="RoslynAnalyzerApiMap.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Analyzers

import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Linq

/// The declarative Roslyn → G# analyzer API map (ADR-0169,
/// docs/cs2gs-analyzer-translation.md). Analyzer translation mode is the
/// one place cs2gs's "third-party CLR APIs pass through untouched" rule is
/// wrong: Microsoft.CodeAnalysis usage must be rewritten to the G#
/// analyzer API, and the analyzed-language surface (SyntaxKind values,
/// syntax node members) to its structurally different G# counterpart.
/// Every entry carries a fidelity class: an (cref:Entry.AdaptationNote)
/// marks an Adapted rewrite (detection semantics shifted — surfaces as a
/// CS2GS-ANALYZER-SHAPE warning); absence from the map is a loud
/// CS2GS-GAP, never a silent passthrough. Identity-mapped members are
/// backstopped by the round-trip binder: a translated member that does not
/// exist on the G# type fails AssertBinds/round-trip, never silently.
internal shared class RoslynAnalyzerApiMap {
    /// A single mapping row.
    /// @param GsNamespace The G# namespace (types only; null for members).
    /// @param GsName The G# spelling, or null when the member has no counterpart.
    /// @param AdaptationNote Non-null marks Adapted fidelity: emit a CS2GS-ANALYZER-SHAPE warning carrying
    /// this note.
    /// @param SharedGsNode True when (cref:GsName) is a G# node shared with the null-conditional
    /// spelling of the same access (issue #4173 round 3) — a bare type-name
    /// substitution over the row would silently over-match, so the translator's
    /// pattern-position leaves route through a dedicated discriminator instead of
    /// this map row directly. See (cref:EnumerateSharedGsNodeTypeNames).
    internal data struct Entry(
        GsNamespace string?,
        GsName string?,
        AdaptationNote string? = nil,
        SharedGsNode bool = false
    ) : IEquatable[Entry] { }

    /// Roslyn namespaces → G# namespaces, for rewriting using directives.
    /// Several C# namespaces collapse onto one G# namespace; the import
    /// de-dup in TranslateDocument handles the collision.
    private let NamespaceMap Dictionary[string, string] = Dictionary[string, string](StringComparer.Ordinal){
        ["Microsoft.CodeAnalysis"] = "GSharp.Core.CodeAnalysis",
        ["Microsoft.CodeAnalysis.Diagnostics"] = "GSharp.Core.CodeAnalysis.Analyzers",
        ["Microsoft.CodeAnalysis.CSharp"] = "GSharp.Core.CodeAnalysis.Syntax",
        ["Microsoft.CodeAnalysis.CSharp.Syntax"] = "GSharp.Core.CodeAnalysis.Syntax",
        ["Microsoft.CodeAnalysis.Operations"] = "GSharp.Core.CodeAnalysis.Binding",
        ["Microsoft.CodeAnalysis.Text"] = "GSharp.Core.CodeAnalysis.Text"
    }

    /// Roslyn type metadata name → G# type. Names deliberately mirror
    /// Roslyn wherever the framework could (ADR-0169), so most entries
    /// change only the namespace.
    private let TypeMap Dictionary[string, Entry] = Dictionary[string, Entry](StringComparer.Ordinal){
        ["Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "GSharpDiagnosticAnalyzer"
        ),
        ["Microsoft.CodeAnalysis.Diagnostics.AnalysisContext"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "AnalysisContext"
        ),
        ["Microsoft.CodeAnalysis.Diagnostics.CompilationStartAnalysisContext"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "CompilationStartAnalysisContext"
        ),
        ["Microsoft.CodeAnalysis.Diagnostics.CompilationAnalysisContext"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "CompilationAnalysisContext"
        ),
        ["Microsoft.CodeAnalysis.Diagnostics.SyntaxNodeAnalysisContext"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "SyntaxNodeAnalysisContext"
        ),
        ["Microsoft.CodeAnalysis.Diagnostics.SyntaxTreeAnalysisContext"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "SyntaxTreeAnalysisContext"
        ),
        ["Microsoft.CodeAnalysis.Diagnostics.SymbolAnalysisContext"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "SymbolAnalysisContext"
        ),
        ["Microsoft.CodeAnalysis.Diagnostics.SemanticModelAnalysisContext"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "SemanticModelAnalysisContext"
        ),
        ["Microsoft.CodeAnalysis.Diagnostics.OperationAnalysisContext"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "BoundNodeAnalysisContext",
            "G# has no IOperation; bound-node actions receive BoundNode, whose member shapes are stable at the kind level only."
        ),
        ["Microsoft.CodeAnalysis.Diagnostics.GeneratedCodeAnalysisFlags"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "GeneratedCodeAnalysisFlags"
        ),
        ["Microsoft.CodeAnalysis.Diagnostics.OperationBlockAnalysisContext"] = Entry(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "BoundBodyAnalysisContext",
            "A G# body action runs once per declared function body; function literals and local functions are part of the body that declares them, and top-level statements are not dispatched."
        ),
        ["Microsoft.CodeAnalysis.DiagnosticDescriptor"] = Entry("GSharp.Core.CodeAnalysis", "DiagnosticDescriptor"),
        ["Microsoft.CodeAnalysis.Diagnostic"] = Entry("GSharp.Core.CodeAnalysis", "Diagnostic"),
        ["Microsoft.CodeAnalysis.DiagnosticSeverity"] = Entry("GSharp.Core.CodeAnalysis", "DiagnosticSeverity"),
        ["Microsoft.CodeAnalysis.SemanticModel"] = Entry("GSharp.Core.CodeAnalysis", "SemanticModel"),
        ["Microsoft.CodeAnalysis.Location"] = Entry(
            "GSharp.Core.CodeAnalysis.Text",
            "TextLocation",
            "TextLocation is a struct with StartLine/StartCharacter; Roslyn's GetLineSpan idioms need review."
        ),
        ["Microsoft.CodeAnalysis.SyntaxNode"] = Entry("GSharp.Core.CodeAnalysis.Syntax", "SyntaxNode"),
        ["Microsoft.CodeAnalysis.SyntaxToken"] = Entry("GSharp.Core.CodeAnalysis.Syntax", "SyntaxToken"),
        ["Microsoft.CodeAnalysis.SyntaxTree"] = Entry("GSharp.Core.CodeAnalysis.Syntax", "SyntaxTree"),
        ["Microsoft.CodeAnalysis.CSharp.SyntaxKind"] = Entry("GSharp.Core.CodeAnalysis.Syntax", "SyntaxKind"),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "ExpressionSyntax"
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ElementAccessExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "IndexExpressionSyntax",
            "G# folds a?[i] onto the SAME node as a[i], distinguished only by an IsNullConditional flag; a bare type test in a pattern position routes through the dedicated discriminator instead of this row directly (issue #4173 round 3).",
            SharedGsNode: true
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.IdentifierNameSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "NameExpressionSyntax"
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "AccessorExpressionSyntax",
            "G# member access is LeftPart/RightPart expressions, not Expression/Name; name extraction becomes RightPart.GetLastToken().Text.",
            SharedGsNode: true
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "ParenthesizedExpressionSyntax"
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "AssignmentExpressionSyntax",
            "G# simple assignment targets an identifier token, and index/member writes are distinct Index/MemberIndexAssignmentExpression nodes — assignment-LHS pattern checks are usually structural no-ops in G#."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "CallExpressionSyntax"
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ObjectCreationExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "CallExpressionSyntax",
            "A C# construction without an object initializer is a direct type call in G#; construction-detection idioms inspect CallExpressionSyntax.Identifier."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.IsPatternExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "IsExpressionSyntax",
            "G# is-expressions carry ADR-0166 pattern shapes; designation and subpattern walks need review."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.VariableDeclaratorSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "VariableDeclarationSyntax",
            "G# declarations are single-declarator; Variables-list walks collapse to the declaration itself."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.TypeSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "TypeClauseSyntax",
            "G# type positions are type clauses; name-extraction helpers need review."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.GenericNameSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "GenericNameExpressionSyntax"
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "FunctionDeclarationSyntax",
            "FunctionDeclaration covers C# methods and local functions; review kind checks that distinguished them."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "PatternSyntax"
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.SwitchStatementSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "SwitchStatementSyntax",
            "G# switch cases carry one pattern each (SwitchCaseSyntax.Value) with no section/label nesting; a Sections.SelectMany(s => s.Labels).OfType<CasePatternSwitchLabelSyntax>() walk is idiom-rewritten to Cases.Where(c => !c.IsDefault && (c.Guard != nil || c.Value is not ConstantPatternSyntax)) (#3536)."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.CasePatternSwitchLabelSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "SwitchCaseSyntax",
            "G# has no per-label node: a case's pattern is SwitchCaseSyntax.Value directly."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.SubpatternSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "PropertyPatternFieldSyntax",
            "G# property-pattern fields carry the field name as Identifier directly; there is no ExpressionColon wrapper."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ArgumentSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "ExpressionSyntax",
            "G# call arguments are bare expressions with no ArgumentSyntax wrapper; a lambda parameter or local typed ArgumentSyntax maps to ExpressionSyntax directly (#3536)."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.SingleVariableDesignationSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "PatternSyntax",
            "G# stores a pattern's optional binding token on the pattern node itself; designation walks filter PatternSyntax.BindingIdentifier."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.WhileStatementSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "WhileStatementSyntax"
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.DoStatementSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "DoWhileStatementSyntax"
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ForStatementSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "ForClauseStatementSyntax",
            "A C-style for-loop with a single declarator/initializer/incrementor and no condition needing clause hoisting translates directly to ForClauseStatementSyntax; TranslateForStatement lowers every other shape (multiple declarators/initializers/incrementors, or a hoisted condition) to a block + WhileStatementSyntax instead (issues #914, #1723) — an ancestor walk checking only ForClauseStatementSyntax misses that lowered shape (though WhileStatementSyntax, separately mapped, still recognizes it as a loop)."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.LambdaExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "LambdaExpressionSyntax"
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.AnonymousMethodExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "LambdaExpressionSyntax",
            "G# has no legacy delegate(...){...} anonymous-method syntax; cs2gs translates a C# anonymous method the same way it translates a lambda, so both collapse onto LambdaExpressionSyntax."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.LocalFunctionStatementSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "FunctionDeclarationSyntax",
            "Same target as MethodDeclarationSyntax above: FunctionDeclarationSyntax covers C# methods and local functions alike; review kind checks that distinguished them."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "StructDeclarationSyntax",
            "Roslyn's TypeDeclarationSyntax is the abstract base for class/struct/interface/record declarations; G# splits these into distinct node types (StructDeclarationSyntax for class/struct, InterfaceDeclarationSyntax for interfaces) with no shared base of their own. This picks the class/struct case; an ancestor walk that also needs to match an interface declaration needs review."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.PostfixUnaryExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "UnaryExpressionSyntax",
            "G# has one unary-expression node for prefix and postfix operators alike; distinguish by OperatorToken.Kind, not node type."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.PrefixUnaryExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "UnaryExpressionSyntax",
            "G# has one unary-expression node for prefix and postfix operators alike; distinguish by OperatorToken.Kind, not node type."
        ),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "ExpressionSyntax",
            "G# folds a?.b onto the SAME node as a.b and a?[i] onto the SAME node as a[i]; a bare cast/variable-typed read gets this non-discriminating supertype, trusting the I2 registration guard for soundness.",
            SharedGsNode: true
        ),
        ["Microsoft.CodeAnalysis.ISymbol"] = Entry("GSharp.Core.CodeAnalysis.Symbols", "Symbol"),
        ["Microsoft.CodeAnalysis.IFieldSymbol"] = Entry("GSharp.Core.CodeAnalysis.Symbols", "FieldSymbol"),
        ["Microsoft.CodeAnalysis.IPropertySymbol"] = Entry("GSharp.Core.CodeAnalysis.Symbols", "PropertySymbol"),
        ["Microsoft.CodeAnalysis.IMethodSymbol"] = Entry("GSharp.Core.CodeAnalysis.Symbols", "FunctionSymbol"),
        ["Microsoft.CodeAnalysis.IParameterSymbol"] = Entry("GSharp.Core.CodeAnalysis.Symbols", "ParameterSymbol"),
        ["Microsoft.CodeAnalysis.SymbolKind"] = Entry("GSharp.Core.CodeAnalysis.Symbols", "SymbolKind"),
        ["Microsoft.CodeAnalysis.SymbolEqualityComparer"] = Entry(
            "GSharp.Core.CodeAnalysis.Symbols",
            "SymbolEqualityComparer"
        ),
        ["Microsoft.CodeAnalysis.MethodKind"] = Entry(
            "GSharp.Core.CodeAnalysis.Symbols",
            "MethodKind",
            "G# MethodKind has Ordinary, AnonymousFunction, LocalFunction, PropertyGet, PropertySet and StaticConstructor only; G# constructors are ConstructorSymbols, not functions."
        ),
        ["Microsoft.CodeAnalysis.AttributeData"] = Entry("GSharp.Core.CodeAnalysis.Binding", "BoundAttribute"),
        ["Microsoft.CodeAnalysis.ILocalSymbol"] = Entry(
            "GSharp.Core.CodeAnalysis.Symbols",
            "VariableSymbol",
            "G# variable references share one node for locals, parameters and globals, so a local-symbol value can also be a parameter."
        ),
        ["Microsoft.CodeAnalysis.IArrayTypeSymbol"] = Entry(
            "GSharp.Core.CodeAnalysis.Symbols",
            "SliceTypeSymbol",
            "C# `T[]` translates to the G# slice `[]T`; G#'s ArrayTypeSymbol is the fixed-length `[N]T`."
        ),
        ["Microsoft.CodeAnalysis.SyntaxReference"] = Entry(
            "GSharp.Core.CodeAnalysis.Syntax",
            "SyntaxNode",
            "DeclaringSyntaxNodes holds SyntaxNodes directly; SyntaxReference locals become nodes and GetSyntax() calls are dropped."
        ),
        ["Microsoft.CodeAnalysis.INamedTypeSymbol"] = Entry(
            "GSharp.Core.CodeAnalysis.Symbols",
            "TypeSymbol",
            "G# has no INamedTypeSymbol split; generic-instantiation idioms (ConstructedFrom, TypeArguments) need review against the concrete TypeSymbol subclass."
        ),
        ["Microsoft.CodeAnalysis.IOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundExpression",
            "IOperation maps to BoundExpression (Type/ConstantValue live on expressions in G#); statement-level operation analyzers need review."
        ),
        ["Microsoft.CodeAnalysis.Operations.IBinaryOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundBinaryOperationExpression",
            "G# has one bound node per operator provenance; the analyzer-facing base spans them, and Op/OperatorKind reads become BinaryOperatorKind."
        ),
        ["Microsoft.CodeAnalysis.Operations.IInvocationOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundCallOperationExpression",
            "G# has one bound node per callee provenance; the analyzer-facing base spans them, and TargetMethod becomes the Symbol-typed CalledFunction."
        ),
        ["Microsoft.CodeAnalysis.Operations.IArgumentOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundExpression",
            "G# call arguments are the bound expressions directly; IArgumentOperation.Value accesses drop."
        ),
        ["Microsoft.CodeAnalysis.Operations.IConversionOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundConversionExpression",
            "G# inserts different implicit conversions than C#; conversion-unwrap loops need review."
        ),
        ["Microsoft.CodeAnalysis.OperationKind"] = Entry("GSharp.Core.CodeAnalysis.Binding", "BoundNodeKind"),
        ["Microsoft.CodeAnalysis.Operations.IMethodReferenceOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundMethodReferenceOperationExpression",
            "G# has one method-group node per callee provenance; the analyzer-facing base spans them. An unresolved group reports its first candidate as Method."
        ),
        ["Microsoft.CodeAnalysis.Operations.IPropertyReferenceOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundPropertyReferenceOperationExpression",
            "G# has one property-read node per provenance; the analyzer-facing base spans them. The imported node also reads fields, for which ReferencedProperty (Roslyn's Property) is nil."
        ),
        ["Microsoft.CodeAnalysis.Operations.ILocalReferenceOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundVariableExpression",
            "G# binds every variable read (local, parameter or global) to BoundVariableExpression."
        ),
        ["Microsoft.CodeAnalysis.Operations.IParameterReferenceOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundVariableExpression",
            "G# binds a parameter read to the same BoundVariableExpression as a local read; ParameterSymbol is a variable symbol."
        ),
        ["Microsoft.CodeAnalysis.Operations.IAssignmentOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundAssignmentExpression",
            "BoundAssignmentExpression assigns a variable; field, property and index writes are separate G# nodes this row does not reach."
        ),
        ["Microsoft.CodeAnalysis.Operations.ISimpleAssignmentOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundAssignmentExpression",
            "BoundAssignmentExpression assigns a variable; field, property and index writes are separate G# nodes this row does not reach."
        ),
        ["Microsoft.CodeAnalysis.Operations.IVariableDeclaratorOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundVariableDeclaration",
            "G# declarations are single-declarator statements; the declarator is the declaration itself."
        ),
        ["Microsoft.CodeAnalysis.Operations.IVariableInitializerOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundExpression",
            "A G# initializer is the bound expression directly; IVariableInitializerOperation.Value accesses drop."
        ),
        ["Microsoft.CodeAnalysis.Operations.IForEachLoopOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundForRangeStatement",
            "A G# for-in loop has a value variable and an optional key variable; Locals lists both."
        ),
        ["Microsoft.CodeAnalysis.Operations.IDeclarationExpressionOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundAddressOfExpression",
            "An inline `out var x` binds to the address of the declared variable; the same node also takes the address of an existing variable (`&x`)."
        ),
        ["Microsoft.CodeAnalysis.Operations.IIsTypeOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundIsExpression",
            "G# is-expressions carry a pattern; a plain type test has IsSimpleTypeTest set and its type in TargetType."
        ),
        ["Microsoft.CodeAnalysis.Operations.ITypePatternOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundTypePattern"
        ),
        ["Microsoft.CodeAnalysis.Operations.IDeclarationPatternOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundTypePattern",
            "G# binds a declaration pattern to the type pattern with a binding (HasBinding)."
        ),
        ["Microsoft.CodeAnalysis.Operations.IRecursivePatternOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundTypePattern",
            "G# binds a typed recursive pattern to the type pattern with a PropertyPattern; an untyped property pattern is a separate node this row does not reach."
        ),
        ["Microsoft.CodeAnalysis.Operations.ITypeOfOperation"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundTypeOfExpression"
        ),
        ["Microsoft.CodeAnalysis.Operations.BinaryOperatorKind"] = Entry(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundBinaryOperatorKind"
        ),
        ["Microsoft.CodeAnalysis.ITypeSymbol"] = Entry("GSharp.Core.CodeAnalysis.Symbols", "TypeSymbol"),
        ["Microsoft.CodeAnalysis.SymbolDisplayFormat"] = Entry(
            "GSharp.Core.CodeAnalysis.Symbols",
            "DisplayFormat",
            "G# collapses SymbolDisplayFormat options into the DisplayFormat enum; verify rendered-string comparisons."
        ),
        ["Microsoft.CodeAnalysis.INamespaceSymbol"] = Entry(
            nil,
            "string",
            "G# has no namespace symbol; ContainingNamespace is the display string directly, so ToDisplayString() calls on it are dropped."
        )
    }

    /// Enum member value renames, keyed by the Roslyn enum's metadata
    /// name. Members not listed for a mapped enum are identity-mapped and
    /// backstopped by the round-trip binder.
    private let EnumMemberMap Dictionary[(Type string?, Member string?), Entry] = Dictionary[
        (Type string, Member string),
        Entry
    ]{
        [("Microsoft.CodeAnalysis.CSharp.SyntaxKind", "ElementAccessExpression")] = Entry(nil, "IndexExpression"),
        [("Microsoft.CodeAnalysis.CSharp.SyntaxKind", "SimpleMemberAccessExpression")] = Entry(
            nil,
            "AccessorExpression"
        ),
        [("Microsoft.CodeAnalysis.CSharp.SyntaxKind", "SimpleAssignmentExpression")] = Entry(
            nil,
            "AssignmentExpression"
        ),
        [("Microsoft.CodeAnalysis.CSharp.SyntaxKind", "IdentifierName")] = Entry(nil, "NameExpression"),
        [("Microsoft.CodeAnalysis.CSharp.SyntaxKind", "InvocationExpression")] = Entry(nil, "CallExpression"),
        [("Microsoft.CodeAnalysis.CSharp.SyntaxKind", "MethodDeclaration")] = Entry(
            nil,
            "FunctionDeclaration",
            "FunctionDeclaration also covers C# local functions; review if the analyzer distinguished them."
        ),
        [("Microsoft.CodeAnalysis.OperationKind", "BinaryOperator")] = Entry(nil, "BinaryExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "Invocation")] = Entry(nil, "CallExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "Conversion")] = Entry(nil, "ConversionExpression"),
        [("Microsoft.CodeAnalysis.SymbolKind", "Method")] = Entry(nil, "Function"),
        [("Microsoft.CodeAnalysis.SymbolKind", "NamedType")] = Entry(nil, "Type"),
        [("Microsoft.CodeAnalysis.OperationKind", "TypeOf")] = Entry(nil, "TypeOfExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "MethodReference")] = Entry(nil, "MethodGroupExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "PropertyReference")] = Entry(nil, "PropertyAccessExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "LocalReference")] = Entry(nil, "VariableExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "ParameterReference")] = Entry(nil, "VariableExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "SimpleAssignment")] = Entry(nil, "AssignmentExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "VariableDeclarator")] = Entry(nil, "VariableDeclaration"),
        [("Microsoft.CodeAnalysis.OperationKind", "IsType")] = Entry(nil, "IsExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "TypePattern")] = Entry(nil, "TypePattern"),
        [("Microsoft.CodeAnalysis.OperationKind", "DeclarationPattern")] = Entry(nil, "TypePattern"),
        [("Microsoft.CodeAnalysis.OperationKind", "RecursivePattern")] = Entry(nil, "TypePattern")
    }

    /// Issue #3920: which G# bound-node kinds a Roslyn
    /// `OperationKind` must REGISTER for. Roslyn has one operation kind
    /// where G# has several bound nodes — a binary operator is a different
    /// node depending on whether it is built in or resolves to an operator
    /// method, and a call is a different node depending on whether the callee
    /// is same-compilation, imported static, or imported instance. Registering
    /// only the first meant a migrated rule was dispatched zero times over
    /// imported code, which is exactly the code GSA0002 exists to police.
    ///
    /// This is the DISPATCH set, deliberately separate from
    /// (cref:EnumMemberMap): a bare `OperationKind` read (e.g.
    /// `node.Kind == OperationKind.TypeOf`) still translates to the one
    /// kind it names, because a read tests a single node's identity while a
    /// registration must cover every node that can arrive.
    private let OperationKindDispatch Dictionary[string, []string] = Dictionary[string, []string](
        StringComparer.Ordinal
    ){
        ["BinaryOperator"] = []string{"BinaryExpression", "ClrBinaryOperatorExpression"},
        ["MethodReference"] = []string{"MethodGroupExpression", "ClrMethodGroupExpression"},
        ["PropertyReference"] = []string{"PropertyAccessExpression", "ClrPropertyAccessExpression"},
        ["IsType"] = []string{"IsExpression"},
        ["Invocation"] = []string{
            "CallExpression",
            "UserInstanceCallExpression",
            "ImportedCallExpression",
            "ImportedInstanceCallExpression",
            "ClrStaticCallExpression",
            "ConstrainedStaticCallExpression",
            "BaseInterfaceCallExpression"
        }
    }

    /// Instance member renames, keyed by the declaring Roslyn type's
    /// metadata name. A null G# name marks a member with NO G#
    /// counterpart: the access is replaced per the note (comparison sites
    /// lower to `false`) and always surfaces a shape warning.
    private let MemberMap Dictionary[(Type string?, Member string?), Entry] = Dictionary[
        (Type string, Member string),
        Entry
    ]{
        [("Microsoft.CodeAnalysis.CSharp.Syntax.ElementAccessExpressionSyntax", "Expression")] = Entry(nil, "Target"),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax", "Name")] = Entry(
            nil,
            "RightPart",
            "AccessorExpressionSyntax.RightPart is an expression; identifier extraction becomes GetLastToken()."
        ),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax", "Expression")] = Entry(nil, "LeftPart"),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax", "Expression")] = Entry(
            nil,
            "Parent",
            "G# member calls are CallExpressionSyntax nodes whose parent is the AccessorExpressionSyntax."
        ),
        [("Microsoft.CodeAnalysis.SyntaxToken", "ValueText")] = Entry(nil, "Text"),
        [("Microsoft.CodeAnalysis.Operations.IConversionOperation", "Operand")] = Entry(nil, "Expression"),
        [("Microsoft.CodeAnalysis.Diagnostics.OperationAnalysisContext", "Operation")] = Entry(nil, "BoundNode"),
        [("Microsoft.CodeAnalysis.INamedTypeSymbol", "TypeArguments")] = Entry(nil, "ConstructedTypeArguments"),
        [("Microsoft.CodeAnalysis.SymbolDisplayFormat", "FullyQualifiedFormat")] = Entry(nil, "FullyQualified"),
        [("Microsoft.CodeAnalysis.SymbolDisplayFormat", "MinimallyQualifiedFormat")] = Entry(nil, "Minimal"),
        [("Microsoft.CodeAnalysis.Diagnostics.AnalysisContext", "RegisterOperationAction")] = Entry(
            nil,
            "RegisterBoundNodeAction",
            "Operation actions become bound-node actions; BoundNode member shapes are stable at the kind level only."
        ),
        [("Microsoft.CodeAnalysis.Operations.IBinaryOperation", "LeftOperand")] = Entry(nil, "Left"),
        [("Microsoft.CodeAnalysis.Diagnostics.AnalysisContext", "RegisterOperationBlockAction")] = Entry(
            nil,
            "RegisterBoundBodyAction",
            "Operation-block actions become bound-body actions, dispatched once per declared function body."
        ),
        [("Microsoft.CodeAnalysis.Diagnostics.OperationBlockAnalysisContext", "OperationBlocks")] = Entry(
            nil,
            "Bodies",
            "A G# function has exactly one bound body."
        ),
        [("Microsoft.CodeAnalysis.IOperation", "ChildOperations")] = Entry(nil, "ChildNodes"),
        [("Microsoft.CodeAnalysis.Operations.IPropertyReferenceOperation", "Property")] = Entry(
            nil,
            "ReferencedProperty"
        ),
        [("Microsoft.CodeAnalysis.Operations.ILocalReferenceOperation", "Local")] = Entry(nil, "Variable"),
        [("Microsoft.CodeAnalysis.Operations.IParameterReferenceOperation", "Parameter")] = Entry(nil, "Variable"),
        [("Microsoft.CodeAnalysis.Operations.IVariableDeclaratorOperation", "Symbol")] = Entry(nil, "Variable"),
        [("Microsoft.CodeAnalysis.Operations.IDeclarationExpressionOperation", "Expression")] = Entry(nil, "Operand"),
        [("Microsoft.CodeAnalysis.Operations.IIsTypeOperation", "TypeOperand")] = Entry(
            nil,
            "TypeOperand",
            "BoundIsExpression.TypeOperand is nil unless the is-expression is a plain type test; a G# is-type registration also receives the pattern forms, whose type is on their BoundTypePattern."
        ),
        [("Microsoft.CodeAnalysis.Operations.IIsTypeOperation", "ValueOperand")] = Entry(nil, "Expression"),
        [("Microsoft.CodeAnalysis.Operations.ITypePatternOperation", "MatchedType")] = Entry(nil, "TargetType"),
        [("Microsoft.CodeAnalysis.Operations.IDeclarationPatternOperation", "MatchedType")] = Entry(nil, "TargetType"),
        [("Microsoft.CodeAnalysis.Operations.IRecursivePatternOperation", "MatchedType")] = Entry(nil, "TargetType"),
        [("Microsoft.CodeAnalysis.Operations.ITypeOfOperation", "TypeOperand")] = Entry(nil, "OperandType"),
        [("Microsoft.CodeAnalysis.Operations.IBinaryOperation", "RightOperand")] = Entry(nil, "Right"),
        [("Microsoft.CodeAnalysis.Operations.IInvocationOperation", "TargetMethod")] = Entry(
            nil,
            "CalledFunction",
            "BoundCallOperationExpression.CalledFunction is Symbol-typed and carries Name/ContainingType only: ReturnType is answered by the call node (the callee symbol holds the DECLARATION's type) and OverriddenMethod is not answerable for an imported callee (#3920, PR #3968 review)."
        ),
        [("Microsoft.CodeAnalysis.IMethodSymbol", "OverriddenMethod")] = Entry(
            nil,
            "OverriddenMethod",
            "FunctionSymbol.OverriddenMethod is the SOURCE override chain only: a method overriding an imported CLR base records its target in ExternalOverriddenMethod, and an imported method has no chain at all, so both report null where Roslyn reports a symbol (PR #3968 review). Review override-chain walks that must see across the metadata boundary."
        ),
        [("Microsoft.CodeAnalysis.IMethodSymbol", "ReturnType")] = Entry(nil, "Type"),
        [("Microsoft.CodeAnalysis.IParameterSymbol", "IsOptional")] = Entry(nil, "HasExplicitDefaultValue"),
        [("Microsoft.CodeAnalysis.INamedTypeSymbol", "BaseType")] = Entry(nil, "BaseType"),
        [("Microsoft.CodeAnalysis.ISymbol", "DeclaringSyntaxReferences")] = Entry(
            nil,
            "DeclaringSyntaxNodes",
            "DeclaringSyntaxNodes holds SyntaxNodes directly; drop GetSyntax() calls."
        ),
        [("Microsoft.CodeAnalysis.ITypeSymbol", "SpecialType")] = Entry(
            nil,
            nil,
            "G# has no SpecialType; comparisons rewrite to fully-qualified display-string checks, other uses fail the round-trip binder."
        ),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax", "Left")] = Entry(
            nil,
            nil,
            "G# index/member writes parse as Index/MemberIndexAssignmentExpression, never as a read node on an assignment's left; the C# assignment-LHS check has no G# counterpart, so comparisons against it lower to 'false'."
        ),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax", "Right")] = Entry(
            nil,
            "Expression",
            "G# simple assignment has a single IdentifierToken target and one Expression value (no Left/Right split); the RHS is Expression directly."
        ),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.CasePatternSwitchLabelSyntax", "Pattern")] = Entry(nil, "Value"),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.SubpatternSyntax", "ExpressionColon")] = Entry(
            nil,
            nil,
            "SubpatternSyntax.ExpressionColon.Expression names the field; G#'s PropertyPatternFieldSyntax.Identifier names it directly and has no ExpressionColon wrapper (#3536)."
        ),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.SingleVariableDesignationSyntax", "Identifier")] = Entry(
            nil,
            "BindingIdentifier",
            "G# stores the designation token on PatternSyntax.BindingIdentifier rather than a child designation node."
        ),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.MemberBindingExpressionSyntax", "Name")] = Entry(
            nil,
            "RightPart",
            "AccessorExpressionSyntax.RightPart is an expression; identifier extraction becomes GetLastToken()."
        ),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.MemberBindingExpressionSyntax", "OperatorToken")] = Entry(
            nil,
            "DotToken",
            "G# token is '?.'; Roslyn's is '.' — wider extent."
        ),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.ElementBindingExpressionSyntax", "ArgumentList")] = Entry(
            nil,
            "Indices",
            "G# has no BracketedArgumentListSyntax wrapper; ElementBindingExpressionSyntax.ArgumentList.Arguments drops straight to Indices."
        )
    }

    /// Roslyn members that Roslyn declares non-null (a `SyntaxToken`
    /// struct, or a reference the API annotates as non-null) but whose G#
    /// analyzer-API counterpart — after any (cref:MemberMap) rename — is
    /// declared `T?`. Keyed by the declaring Roslyn type's metadata name
    /// and the Roslyn member name.
    ///
    /// Issue #4356: C#'s own nullability says nothing about these, so none of
    /// the translator's forgiveness predicates, which read the C# symbol, can
    /// see that the translated read is `T?`. A dereference through one
    /// (`parameter.Identifier.Text`) then printed without a `!!`, and
    /// only bound at all because gsc's member lookup waved a chained imported
    /// read through regardless of its stated nullability. Each row makes the
    /// read a nullable-reference receiver in analyzer mode, so it gets the same
    /// `!!` as a Roslyn-annotated `T?` member would.
    /// (cref:IsNamespaceSymbolType) is the same mismatch for a whole
    /// type rather than one member.
    private let GSharpNullableMembers HashSet[(Type string?, Member string)] = HashSet[(Type string, Member string)]{
        ("Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax", "Identifier"),
        ("Microsoft.CodeAnalysis.CSharp.Syntax.SingleVariableDesignationSyntax", "Identifier"),
        ("Microsoft.CodeAnalysis.IOperation", "Syntax"),
        ("Microsoft.CodeAnalysis.Operations.IIsTypeOperation", "TypeOperand"),
        ("Microsoft.CodeAnalysis.Operations.IMethodReferenceOperation", "Method"),
        ("Microsoft.CodeAnalysis.Operations.IPropertyReferenceOperation", "Property"),
        ("Microsoft.CodeAnalysis.ISymbol", "ContainingType")
    }

    /// Issue #4356: the Roslyn declared types of the (cref:GSharpNullableMembers)
    /// rows — the types a value can have while being `T?` only on the G#
    /// side. A local of one of these types whose emitted G# nullability was not
    /// recorded is treated as nullable (fail-safe: at worst a redundant
    /// `!!`). Keep in step with (cref:GSharpNullableMembers).
    private let GSharpNullableCapableTypes HashSet[string] = HashSet[string](StringComparer.Ordinal){
        "Microsoft.CodeAnalysis.SyntaxToken",
        "Microsoft.CodeAnalysis.SyntaxNode"
    }

    /// Whether the Roslyn member [`memberName`](paramref) declared on
    /// [`typeMetadataName`](paramref) is non-null in Roslyn but `T?`
    /// on the G# analyzer API (see (cref:GSharpNullableMembers)).
    /// @param typeMetadataName The declaring Roslyn type's metadata name.
    /// @param memberName The Roslyn member name.
    /// @returns True when the G# counterpart is declared nullable.
    func IsGSharpNullableMember(typeMetadataName string?, memberName string) bool -> typeMetadataName != nil &&
        GSharpNullableMembers.Contains((typeMetadataName, memberName))

    /// Whether a value of this Roslyn type can be `T?` only on the G# side.
    /// @param typeMetadataName The Roslyn type's metadata name.
    /// @returns True for a type some G#-nullable analyzer-API member has.
    func IsGSharpNullableCapableType(typeMetadataName string?) bool -> typeMetadataName != nil &&
        GSharpNullableCapableTypes.Contains(typeMetadataName)

    /// Determines whether [`namespaceName`](paramref) belongs to the
    /// Roslyn API surface this map rewrites.
    /// @param namespaceName A namespace display string.
    /// @returns True for Microsoft.CodeAnalysis and its descendants.
    func IsRoslynNamespace(namespaceName string?) bool -> namespaceName != nil &&
        (
        namespaceName == "Microsoft.CodeAnalysis" || namespaceName.StartsWith(
            "Microsoft.CodeAnalysis.",
            StringComparison.Ordinal
        )
    )

    /// Maps a Roslyn namespace to its G# counterpart for import rewriting.
    /// @param namespaceName The Roslyn namespace.
    /// @param gsNamespace The G# namespace.
    /// @returns True when mapped.
    func TryMapNamespace(namespaceName string?, out gsNamespace string) bool -> NamespaceMap.TryGetValue(
        namespaceName!!,
        out gsNamespace
    )

    /// Maps a Roslyn type metadata name to its G# type.
    /// @param metadataName The Roslyn type's full metadata name.
    /// @param entry The mapped G# namespace/name plus any adaptation note.
    /// @returns True when mapped; false means CS2GS-GAP.
    func TryMapType(metadataName string, out entry Entry) bool -> TypeMap.TryGetValue(metadataName, out entry)

    /// True when [`type`](paramref) is Roslyn's `INamespaceSymbol`,
    /// which analyzer mode maps to G#'s namespace display string. The G#
    /// surface is honestly nullable (`Symbol.ContainingNamespace` is
    /// `string?`), while Roslyn annotates `INamespaceSymbol` members
    /// and parameters non-nullable — so both the mapped type and every
    /// nullability decision about a value of this type must treat the G#
    /// counterpart as `string?` regardless of the C# annotation.
    /// @param type The bound C# type.
    /// @returns True for Microsoft.CodeAnalysis.INamespaceSymbol.
    func IsNamespaceSymbolType(type ITypeSymbol?) bool -> type is INamedTypeSymbol named &&
        named.Name == "INamespaceSymbol" &&
        named
        .ContainingNamespace
        ?.ToDisplayString() == "Microsoft.CodeAnalysis"

    /// The G# bound-node kinds a `RegisterOperationAction` for
    /// [`operationKindMember`](paramref) must register (issue #3920).
    /// @param operationKindMember The `OperationKind` member name.
    /// @param boundNodeKinds The G# `BoundNodeKind` member names.
    /// @returns True when the kind fans out to more than the one it names.
    func TryMapOperationKindDispatch(
        operationKindMember string,
        out boundNodeKinds[]string
    ) bool -> OperationKindDispatch.TryGetValue(operationKindMember, out boundNodeKinds)

    /// Maps a Roslyn enum member to its G# spelling.
    /// @param enumMetadataName The declaring enum's metadata name.
    /// @param memberName The enum member.
    /// @param entry The mapped member plus any adaptation note.
    /// @returns True when an explicit rename exists; false means identity.
    func TryMapEnumMember(
        enumMetadataName string?,
        memberName string?,
        out entry Entry
    ) bool -> EnumMemberMap.TryGetValue((enumMetadataName, memberName), out entry)

    /// Maps a Roslyn instance member to its G# spelling.
    /// @param typeMetadataName The declaring type's metadata name.
    /// @param memberName The member name.
    /// @param entry The mapped member (null (cref:Entry.GsName) = no counterpart) plus any note.
    /// @returns True when an explicit mapping exists; false means identity.
    func TryMapMember(typeMetadataName string?, memberName string?, out entry Entry) bool -> MemberMap.TryGetValue(
        (typeMetadataName, memberName),
        out entry
    )

    /// Enumerates every G# namespace that analyzer translation may synthesize
    /// from a Roslyn namespace, type, member, or attribute rewrite.
    /// @returns The mapped target namespaces. Duplicates are permitted.
    internal func EnumerateTargetNamespaces() sequence[string] {
        for targetNamespace in NamespaceMap.Values {
            yield targetNamespace
        }
        for entry in TypeMap.Values {
            if !string.IsNullOrEmpty(entry.GsNamespace) {
                yield entry.GsNamespace
            }
        }
    }

    /// Enumerates the metadata names of every (cref:TypeMap) row flagged
    /// (cref:Entry.SharedGsNode) (issue #4173 round 3, §4.5 drift test —
    /// a Cs2Gs.Tests test asserts this set agrees with the translator's own
    /// shared-node registry, so a future shared-node row cannot be added to
    /// one without the other).
    /// @returns The flagged rows' metadata names.
    internal func EnumerateSharedGsNodeTypeNames() IEnumerable[string] -> TypeMap.Where(
        (kv KeyValuePair[string, Entry]) -> kv.Value.SharedGsNode
    )
        .Select((kv KeyValuePair[string, Entry]) -> kv.Key)
}
