// <copyright file="Binder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Binder.
/// </summary>
public sealed class Binder
{
#pragma warning disable SA1202 // 'internal' members should appear before 'private' members — kept in original positions during PR-B-8 extraction to minimize diff churn.
    /// <summary>
    /// Targets permitted on a function declaration (member or free):
    /// <c>method</c> by default; <c>return</c> via use-site qualifier.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> FunctionDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Method, AttributeTargetKind.Return);

    /// <summary>
    /// Targets permitted on a parameter: only <c>param</c>.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> ParameterAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Param);

    /// <summary>
    /// Targets permitted on a type-shaped declaration
    /// (<c>struct</c> / <c>interface</c> / <c>enum</c> / type alias).
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> TypeDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Type);

    /// <summary>
    /// Targets permitted on a field declaration: only <c>field</c>.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> FieldDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Field);

    /// <summary>
    /// Targets permitted on a property declaration (ADR-0051):
    /// <c>property</c> by default; <c>field</c> for the backing field;
    /// <c>method</c> for the synthesized accessors.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> PropertyDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Property, AttributeTargetKind.Field, AttributeTargetKind.Method);

    /// <summary>
    /// Targets permitted on an event declaration (ADR-0052):
    /// <c>event</c> by default; <c>field</c> for the backing field;
    /// <c>method</c> for the synthesized add/remove accessors.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> EventDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Event, AttributeTargetKind.Field, AttributeTargetKind.Method);

    /// <summary>
    /// Targets permitted on a <c>var</c>/<c>let</c>/<c>const</c> variable
    /// declaration. ADR-0047 §2 assigns the default target <c>field</c> to
    /// these declarations (both at top level — where the variable becomes a
    /// CLR static field — and in local scope — where the attribute carries
    /// compiler-recognised semantics like <c>@Obsolete</c> for use-site
    /// diagnostics).
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> VariableDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Field);

    // PR-B-1: cross-cutting binder state lives on BinderContext so the
    // upcoming Binder-component extractions (MemberLookup, ConversionClassifier,
    // OverloadResolver, …) can consume it via constructor injection. The
    // `scope` member is kept as a forwarding property here purely to limit the
    // diff in this PR; subsequent extractions will switch to `binderCtx.RootScope`.
    private readonly BinderContext binderCtx;

    // PR-B-2: the pure "given a type T and a name N, return the candidates"
    // facade. Consumes the BinderContext for the reference resolver / scope
    // and delegates low-level CLR member walks to ClrTypeUtilities. Composed,
    // not inherited; MemberLookup never back-references Binder.
    private readonly MemberLookup memberLookup;

    // PR-B-3: the binder-side wrapper around Conversion.Classify. Owns the
    // BindConversion / BindClr*Conversion family, the CLR-parameter conversion
    // / argument-shaping helpers, the method-group → delegate resolution, the
    // ref-kind argument validation, and the default-value attachment that
    // previously lived directly on Binder. Composed via narrow Func callbacks
    // for the still-on-Binder helpers it needs to call back into; never
    // back-references Binder.
    private readonly ConversionClassifier conversions;

    // PR-B-4: the binder-side facade for call-site overload resolution.
    // Owns BindCallExpression / BindConstructorCallExpression /
    // BindExtensionFunctionCall / BindUserInstanceCall plus their
    // supporting machinery (named-argument reordering, default-value
    // fill, params lowering, generic type-argument inference, candidate
    // selection, and diagnostic emission). Wraps the pure reflection-level
    // resolver in OverloadResolution.cs (which is unchanged). Composed
    // via Func / custom-delegate callbacks; never back-references Binder.
    private readonly OverloadResolver overloads;

    // PR-B-5: the binder-side facade for per-pattern-kind binding.
    // Owns BindPattern dispatch plus BindConstantPattern / BindTypePattern
    // / BindPropertyPattern / BindRelationalPattern / BindListPattern.
    // Switch-statement / switch-expression glue (discriminant binding,
    // arm walking, exhaustiveness reporting, narrowing-frame management)
    // stays on Binder for now and will move to StatementBinder (B-7) and
    // ExpressionBinder (B-9). Composed via narrow Func callbacks; never
    // back-references Binder.
    private readonly PatternBinder patterns;

    // PR-B-6: the binder-side facade for function-literal (lambda)
    // binding. Owns BindFunctionLiteralExpression, the captured-variable
    // analysis (CapturedVariableCollector), the erased-adapter
    // synthesizer (CreateErasedFunctionLiteralAdapter +
    // ErasedFunctionLiteralAdapterRewriter), the async-return-type
    // widening helper (WrapAsTask), and the TryGetFunctionLiteral
    // unwrap helper. Composed via narrow Func / Action callbacks;
    // never back-references Binder. TryGetFunctionLiteral remains
    // accessible as `LambdaBinder.TryGetFunctionLiteral` so this
    // constructor can keep forwarding it as the
    // `OverloadResolver.TryGetFunctionLiteralDelegate` wired into
    // `OverloadResolver`'s constructor below.
    private readonly LambdaBinder lambdas;

    // PR-B-7: the binder-side facade for per-statement-kind binding. Owns
    // every Bind*Statement (block / variable declaration / if / for-family /
    // try / throw / using / defer / go / channel-send / select / scope /
    // yield / break / continue / return / expression-statement) plus the
    // narrowing helpers (nil-guard, MemberNotNullWhen merging, pattern
    // narrowing) and several deferred-call bookkeeping helpers consumed
    // only by statement binders. Composed via narrow Func / delegate
    // callbacks; never back-references Binder.
    private readonly StatementBinder statements;

    // PR-B-8: the binder-side facade for per-declaration-kind binding. Owns
    // every Bind*Declaration (type alias, named delegate, enum, struct,
    // interface, function), `BindStructDeclarationBody` plus its
    // interface-implementation verification pass, `BindConstructorDeclarations`
    // and the `: base(...)` initializer resolvers, `BindTypeParameterList`,
    // the two symbol-construction `BindVariableDeclaration` overloads, the
    // declaration-side attribute binder (`BindAttributes` / `BindAttribute`),
    // and the queue of pending struct→interface implementation checks. Composed
    // via narrow Func / delegate callbacks; never back-references Binder.
    private readonly DeclarationBinder declarations;

    private FunctionSymbol function;

    // SA1202 exempt: static initializer placement matches Binder's design.
#pragma warning disable SA1642
    /// <summary>
    /// Static-initializer hook for <see cref="Binder"/>.
    /// </summary>
#pragma warning restore SA1642
    static Binder()
    {
        // Stream E: let overload-resolution see user-defined op_Implicit when
        // built-in conversions don't apply. Implicit-only here — explicit
        // conversions never participate in overload tie-breaking.
        OverloadResolution.UserDefinedImplicitConversionLookup ??= (source, target) =>
            ClrOperatorResolution.TryResolveConversion(source, target, allowExplicit: false, out _, out _);
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="Binder"/> class.
    /// </summary>
    /// <param name="parent">The parent scope.</param>
    /// <param name="function">The function to bind.</param>
    public Binder(BoundScope parent, FunctionSymbol function)
    {
        binderCtx = new BinderContext(parent);
        memberLookup = new MemberLookup(binderCtx);
        conversions = new ConversionClassifier(
            binderCtx,
            memberLookup,
            bindExpression: syntax => BindExpression(syntax),
            bindExpressionWithTargetType: (syntax, targetType) => BindExpression(syntax, targetType),
            isFormattableStringTargetType: IsFormattableStringTargetType,
            bindInterpolatedStringAsFormattable: (syntax, targetType) => BindInterpolatedStringAsFormattable(syntax, targetType),
            createErasedFunctionLiteralAdapter: (literal, targetFunctionType) => lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType),
            isLvalue: IsLvalue,
            getRefKindFromModifier: GetRefKindFromModifier,
            refKindToString: RefKindToString);
        overloads = new OverloadResolver(
            binderCtx,
            memberLookup,
            conversions,
            bindExpression: syntax => BindExpression(syntax),
            bindRefArgumentExpression: (refSyntax, parameter) => BindRefArgumentExpression(refSyntax, parameter),
            bindTypeClause: BindTypeClause,
            lookupType: LookupType,
            reportObsoleteUseIfApplicable: ReportObsoleteUseIfApplicable,
            tryBindClrConstructorCall: TryBindClrConstructorCall,
            tryBindIntrinsicCall: TryBindIntrinsicCall,
            tryBindInheritedClrInstanceCall: TryBindInheritedClrInstanceCall,
            isFormattableStringTargetType: IsFormattableStringTargetType,
            bindInterpolatedStringAsFormattable: (syntax, targetType) => BindInterpolatedStringAsFormattable(syntax, targetType),
            getRefKindFromModifier: GetRefKindFromModifier,
            refKindToString: RefKindToString,
            createErasedFunctionLiteralAdapter: (literal, targetFunctionType) => lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType),
            wrapAsTask: t => lambdas.WrapAsTask(t),
            isAsyncIteratorReturnType: IsAsyncIteratorReturnType,
            tryGetFunctionLiteral: LambdaBinder.TryGetFunctionLiteral,
            inferTypeArguments: InferTypeArguments,
            substituteType: SubstituteType,
            satisfiesConstraint: SatisfiesConstraint,
            describeConstraint: DescribeConstraint,
            getCurrentFunction: () => this.function);
        patterns = new PatternBinder(
            binderCtx,
            conversions,
            bindExpression: syntax => BindExpression(syntax),
            bindTypeClause: BindTypeClause,
            isNilLiteral: StatementBinder.IsNilLiteral);
        lambdas = new LambdaBinder(
            binderCtx,
            conversions,
            bindBlockStatement: syntax => statements.BindBlockStatement(syntax),
            bindTypeClause: BindTypeClause,
            bindReturnTypeClause: (syntax, isAsync) => BindReturnTypeClause(syntax, isAsync),
            isAsyncIteratorReturnType: IsAsyncIteratorReturnType,
            resolveClrTypeForGenericArg: ResolveClrTypeForGenericArg,
            getCurrentFunction: () => this.function,
            setCurrentFunction: fn => this.function = fn);
        statements = new StatementBinder(
            binderCtx,
            conversions,
            patterns,
            bindExpression: (syntax, canBeVoid) => BindExpression(syntax, canBeVoid),
            bindExpressionWithTargetType: (syntax, targetType) => BindExpression(syntax, targetType),
            bindTypeClause: BindTypeClause,
            bindLocalVariable: (identifier, isReadOnly, type) => declarations.BindVariableDeclaration(identifier, isReadOnly, type),
            bindLocalVariableWithAccessibility: (identifier, isReadOnly, type, accessibility) => declarations.BindVariableDeclaration(identifier, isReadOnly, type, accessibility),
            bindVariableReference: (name, location) => BindVariableReference(name, location),
            bindInterpolatedStringAsFormattable: (syntax, targetType) => BindInterpolatedStringAsFormattable(syntax, targetType),
            isFormattableStringTargetType: IsFormattableStringTargetType,
            isLvalue: IsLvalue,
            isIteratorReturnType: IsIteratorReturnType,
            resolveAccessibility: ResolveAccessibility,
            bindVariableDeclarationAttributes: (annotations, positionDescription) => declarations.BindAttributes(annotations, AttributeTargetKind.Field, VariableDeclarationAllowedTargets, positionDescription, System.AttributeTargets.Field),
            getCurrentFunction: () => this.function);
        declarations = new DeclarationBinder(
            binderCtx,
            conversions,
            bindExpression: syntax => BindExpression(syntax),
            bindTypeClause: BindTypeClause,
            bindReturnTypeClause: (syntax, isAsync) => BindReturnTypeClause(syntax, isAsync),
            bindTypeOfExpression: syntax => BindTypeOfExpression(syntax),
            bindArrayCreationExpression: syntax => BindArrayCreationExpression(syntax),
            resolveAccessibility: ResolveAccessibility,
            lookupType: LookupType,
            getEffectiveArgumentClrType: GetEffectiveArgumentClrType,
            isAsyncIteratorReturnType: IsAsyncIteratorReturnType,
            isAsyncSequenceReturnType: IsAsyncSequenceReturnType,
            isPrimitiveTypeName: IsPrimitiveTypeName,
            refKindToString: RefKindToString,
            getCurrentFunction: () => this.function);
        this.function = function;

        if (function != null)
        {
            // Pre-compute parameter names once so both instance-member and
            // static-member seeding can defer to parameters (parameter wins
            // on name collision with a sibling static member; the existing
            // instance-vs-parameter precedence — instance pseudo-vars win
            // today via TryDeclareVariable's silent-skip — is preserved
            // verbatim for backward compatibility).
            var paramNames = new HashSet<string>(function.Parameters.Select(p => p.Name));

            // `seenMembers` tracks names already consumed by an instance
            // field/property so we can refuse to expose a same-named static
            // member by bare name (instance wins). It is also reused as the
            // de-dup set within the instance-member inheritance walk below.
            var seenMembers = new HashSet<string>();

            if (function.ThisParameter != null)
            {
                scope.TryDeclareVariable(function.ThisParameter);

                // ADR-0058 / issue #376: for ref struct instance methods, the implicit
                // `this` parameter has function-local safe-to-escape by default (scoped).
                // Only [UnscopedRef] relaxes this, allowing `this` to be returned.
                if (TypeSymbol.IsByRefLike(function.ReceiverType) && !DeclarationBinder.HasUnscopedRefAnnotation(function))
                {
                    function.ThisParameter.IsScoped = true;
                }

                // Phase 3.B.3 sub-step 2b: expose each field on the receiver
                // as a bare name inside the method body. Field access lowers
                // to `this.<field>` at name resolution time.
                // Sub-step 3: walk inheritance chain so inherited fields are
                // also accessible via bare name. Derived shadowing wins.
                if (function.ReceiverType is StructSymbol receiverStruct)
                {
                    for (var t = receiverStruct; t != null; t = t.BaseClass)
                    {
                        if (!t.Fields.IsDefaultOrEmpty)
                        {
                            foreach (var fld in t.Fields)
                            {
                                if (seenMembers.Add(fld.Name))
                                {
                                    scope.TryDeclareVariable(new ImplicitFieldVariableSymbol(function.ThisParameter, t, fld));
                                }
                            }
                        }

                        if (!t.Properties.IsDefaultOrEmpty)
                        {
                            foreach (var prop in t.Properties)
                            {
                                if (seenMembers.Add(prop.Name))
                                {
                                    scope.TryDeclareVariable(new ImplicitPropertyVariableSymbol(function.ThisParameter, t, prop));
                                }
                            }
                        }
                    }
                }
            }

            // Issue #261 / ADR-0053: expose sibling static fields and static
            // properties of the enclosing user type as bare names inside both
            // shared method bodies AND instance method bodies, so that
            //
            //     type Counter class {
            //         shared { prop CallCount int32 }
            //         func Bump() { CallCount += 1 }    // bare access OK
            //     }
            //
            // resolves without requiring `TypeName.` prefix. Static members
            // are exposed for the enclosing type only (no base-class walk) —
            // this is consistent with the qualified `Type.StaticMember`
            // paths (BindUserTypeStaticMemberAccess, BindFieldAssignmentExpression)
            // which also do not walk inheritance for statics today.
            //
            // Shadowing precedence (enforced by paramNames/seenMembers):
            //   parameter > instance member > static member.
            var ownerStruct = (function.StaticOwnerType as StructSymbol)
                ?? (function.ReceiverType as StructSymbol);
            if (ownerStruct != null)
            {
                if (!ownerStruct.StaticFields.IsDefaultOrEmpty)
                {
                    foreach (var fld in ownerStruct.StaticFields)
                    {
                        if (paramNames.Contains(fld.Name) || seenMembers.Contains(fld.Name))
                        {
                            continue;
                        }

                        if (seenMembers.Add(fld.Name))
                        {
                            scope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(ownerStruct, fld));
                        }
                    }
                }

                if (!ownerStruct.StaticProperties.IsDefaultOrEmpty)
                {
                    foreach (var prop in ownerStruct.StaticProperties)
                    {
                        if (paramNames.Contains(prop.Name) || seenMembers.Contains(prop.Name))
                        {
                            continue;
                        }

                        if (seenMembers.Add(prop.Name))
                        {
                            scope.TryDeclareVariable(new ImplicitStaticPropertyVariableSymbol(ownerStruct, prop));
                        }
                    }
                }
            }

            foreach (var p in function.Parameters)
            {
                if (ReferenceEquals(p, function.ThisParameter))
                {
                    continue;
                }

                scope.TryDeclareVariable(p);
            }

            // Phase 4.1 / ADR-0020: expose declared generic type parameters
            // when binding the function body so that `T` resolves inside the
            // body to the TypeParameterSymbol. Issue #312: a method may carry
            // both the enclosing type's type parameters (when it is a member of
            // a generic class) and its own method-level type parameters; seed
            // the enclosing type's first, then the method's own so the latter
            // shadow on name collision.
            var enclosingGenericOwner = (function.ReceiverType ?? function.StaticOwnerType) as StructSymbol;
            var enclosingTypeParams = enclosingGenericOwner?.Definition?.TypeParameters
                ?? enclosingGenericOwner?.TypeParameters
                ?? ImmutableArray<TypeParameterSymbol>.Empty;
            if (!enclosingTypeParams.IsDefaultOrEmpty || function.IsGeneric)
            {
                binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                foreach (var tp in enclosingTypeParams)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }

                foreach (var tp in function.TypeParameters)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }
            }
        }
    }

    /// <summary>
    /// Gets the diagnostics bag.
    /// </summary>
    public DiagnosticBag Diagnostics => binderCtx.Diagnostics;

#pragma warning disable SA1300 // Element should begin with an uppercase letter
    private BoundScope scope
#pragma warning restore SA1300
    {
        get => binderCtx.RootScope;
        set => binderCtx.RootScope = value;
    }

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, resulting in a new chained global scope.
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope previous, ImmutableArray<SyntaxTree> syntaxTrees)
        => BindGlobalScope(previous, syntaxTrees, references: null, implicitSystemImport: true);

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, resulting in
    /// a new chained global scope, using the supplied reference resolver to
    /// look up imported CLR types.
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <param name="references">The reference resolver; <c>null</c> selects <see cref="ReferenceResolver.Default"/>.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver references)
        => BindGlobalScope(previous, syntaxTrees, references, implicitSystemImport: true);

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, with full control over implicit-import seeding.
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <param name="references">The reference resolver; <c>null</c> selects <see cref="ReferenceResolver.Default"/>.</param>
    /// <param name="implicitSystemImport">When <c>true</c>, an implicit <c>import System</c> is seeded before user imports are processed.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver references, bool implicitSystemImport)
        => BindGlobalScope(previous, syntaxTrees, references, implicitSystemImport, preprocessorSymbols: null);

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, with full
    /// control over implicit-import seeding and the active preprocessor
    /// symbol set used by <c>[Conditional("SYMBOL")]</c> call-site elision
    /// (ADR-0047 §6 / issue #176).
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <param name="references">The reference resolver; <c>null</c> selects <see cref="ReferenceResolver.Default"/>.</param>
    /// <param name="implicitSystemImport">When <c>true</c>, an implicit <c>import System</c> is seeded before user imports are processed.</param>
    /// <param name="preprocessorSymbols">The active preprocessor symbol set; <c>null</c> means the empty set.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver references, bool implicitSystemImport, ImmutableHashSet<string> preprocessorSymbols)
    {
        var parentScope = CreateParentScope(previous, references, preprocessorSymbols);
        var binder = new Binder(parentScope, function: null);

        if (implicitSystemImport && previous == null)
        {
            // Seed an implicit `import System` so common BCL types (Console,
            // String, Int32, ...) resolve without an explicit import. The user
            // may still write `import System` redundantly; lookup short-circuits
            // on the first matching import so duplicates are harmless.
            binder.scope.TryImport(new ImportSymbol("System", "System", declaration: null));
        }

        // Resolve each syntax tree's package declaration to a PackageSymbol.
        // Trees without a `package X` declaration fall into the implicit
        // "Default" package; trees that share a textual package name share a
        // PackageSymbol instance. The set of distinct packages, in first-seen
        // order, becomes BoundGlobalScope.Packages.
        var packagesByName = new Dictionary<string, PackageSymbol>(StringComparer.Ordinal);
        var packagesInOrder = ImmutableArray.CreateBuilder<PackageSymbol>();
        var packageByTree = new Dictionary<SyntaxTree, PackageSymbol>();
        foreach (var tree in syntaxTrees)
        {
            var packageSyntax = tree.Root.Members.OfType<PackageSyntax>().FirstOrDefault();
            var packageName = packageSyntax != null
                ? string.Concat(packageSyntax.IdentifiersWithDots.Select(t => t.Text))
                : "Default";
            if (!packagesByName.TryGetValue(packageName, out var packageSymbol))
            {
                packageSymbol = new PackageSymbol(packageName, packageSyntax);
                packagesByName[packageName] = packageSymbol;
                packagesInOrder.Add(packageSymbol);
                AttachDocumentation(packageSymbol, packageSyntax);
            }

            packageByTree[tree] = packageSymbol;
        }

        var importDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                 .OfType<ImportSyntax>();
        foreach (var import in importDeclarations)
        {
            binder.BindImport(import);
        }

        var typeAliasDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                               .OfType<TypeAliasDeclarationSyntax>();
        foreach (var typeAlias in typeAliasDeclarations)
        {
            binder.declarations.BindTypeAliasDeclaration(typeAlias);
        }

        // ADR-0059 / issue #255: declare named delegate types BEFORE
        // interfaces/structs/enums so that interface methods, struct fields,
        // event handler types, etc. can reference a named delegate by name.
        var delegateDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                              .OfType<DelegateDeclarationSyntax>();
        foreach (var delegateSyntax in delegateDeclarations)
        {
            var owningPackage = packageByTree[delegateSyntax.SyntaxTree];
            binder.declarations.BindDelegateDeclaration(delegateSyntax, owningPackage);
        }

        var interfaceDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                               .OfType<InterfaceDeclarationSyntax>();

        // Phase 3 exit: register interface type aliases up front so structs
        // declared in subsequent passes can implement them, *and* defer the
        // resolution of interface method signatures until after structs have
        // been registered — interface methods may reference user struct/class
        // types as parameter or return types (e.g. `func Find(...) Contact?`).
        var declaredInterfaces = new List<(InterfaceDeclarationSyntax Syntax, InterfaceSymbol Symbol)>();
        foreach (var ifaceSyntax in interfaceDeclarations)
        {
            var owningPackage = packageByTree[ifaceSyntax.SyntaxTree];
            var sym = binder.declarations.DeclareInterfaceSymbol(ifaceSyntax, owningPackage);
            if (sym != null)
            {
                declaredInterfaces.Add((ifaceSyntax, sym));
            }
        }

        var enumDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                           .OfType<EnumDeclarationSyntax>();
        foreach (var enumSyntax in enumDeclarations)
        {
            var owningPackage = packageByTree[enumSyntax.SyntaxTree];
            binder.declarations.BindEnumDeclaration(enumSyntax, owningPackage);
        }

        var structDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                            .OfType<StructDeclarationSyntax>();
        foreach (var structSyntax in structDeclarations)
        {
            var owningPackage = packageByTree[structSyntax.SyntaxTree];
            binder.declarations.BindStructDeclaration(structSyntax, owningPackage);
        }

        foreach (var (ifaceSyntax, ifaceSymbol) in declaredInterfaces)
        {
            var owningPackage = packageByTree[ifaceSyntax.SyntaxTree];
            binder.declarations.BindInterfaceMembers(ifaceSyntax, ifaceSymbol, owningPackage);
        }

        var functionDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                              .OfType<FunctionDeclarationSyntax>();
        foreach (var function in functionDeclarations)
        {
            var owningPackage = packageByTree[function.SyntaxTree];
            binder.declarations.BindFunctionDeclaration(function, owningPackage);
        }

        binder.declarations.VerifyInterfaceImplementations();

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var globalStatements = syntaxTrees.SelectMany(st => st.Root.Members)
                                          .OfType<GlobalStatementSyntax>()
                                          .ToArray();
        foreach (var globalStatement in globalStatements)
        {
            var statement = binder.statements.BindStatement(globalStatement.Statement);
            statements.Add(statement);
        }

        var imports = binder.scope.GetDeclaredImports();
        var functions = binder.scope.GetDeclaredFunctions();
        var extensionFunctions = binder.scope.GetDeclaredExtensionFunctions();
        if (!extensionFunctions.IsDefaultOrEmpty)
        {
            functions = functions.AddRange(extensionFunctions);
        }

        var variables = binder.scope.GetDeclaredVariables();
        var typeAliases = binder.scope.GetDeclaredTypeAliases();
        var structs = binder.scope.GetDeclaredStructs();
        var interfaces = binder.scope.GetDeclaredInterfaces();
        var enums = binder.scope.GetDeclaredEnums();

        // Entry-point package: the package owning the top-level statements
        // (if any) or the package owning explicit Main (if any) or, lacking
        // both, the first declared package. This becomes Package — the
        // legacy single-package accessor — and the namespace that owns the
        // synthesized <Main>$ in emit.
        var entryPointPackage = ResolveEntryPointPackage(packageByTree, globalStatements, functions, packagesInOrder);
        var entryPoint = ResolveEntryPoint(binder, functions, globalStatements, syntaxTrees, entryPointPackage);

        var diagnostics = binder.Diagnostics.ToImmutableArray();

        if (previous != null)
        {
            diagnostics = diagnostics.InsertRange(0, previous.Diagnostics);
        }

        var delegates = binder.scope.GetDeclaredDelegates();

        var result = new BoundGlobalScope(previous, entryPointPackage, packagesInOrder.ToImmutable(), diagnostics, imports, functions, variables, typeAliases, structs, interfaces, enums, delegates, entryPoint, statements.ToImmutable());
        result.PreprocessorSymbols = preprocessorSymbols ?? ImmutableHashSet<string>.Empty;
        return result;
    }

    /// <summary>
    /// Produces a bound program from the specified global scope.
    /// </summary>
    /// <param name="globalScope">The global scope.</param>
    /// <param name="references">
    /// The reference resolver used to resolve imported CLR types inside function and
    /// method bodies. When omitted, function-body scopes fall back to
    /// <see cref="ReferenceResolver.Default"/>, which only carries core/System
    /// assemblies — causing imports of non-System namespaces (e.g. types from
    /// referenced libraries or third-party packages) to fail inside bodies.
    /// </param>
    /// <returns>A bound program.</returns>
    public static BoundProgram BindProgram(BoundGlobalScope globalScope, ReferenceResolver references = null)
    {
        var parentScope = CreateParentScope(globalScope, references, preprocessorSymbols: globalScope?.PreprocessorSymbols);

        var functionBodies = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
        var diagnostics = ImmutableArray.CreateBuilder<Diagnostic>();

        var scope = globalScope;

        while (scope != null)
        {
            foreach (var function in scope.Functions)
            {
                var binder = new Binder(parentScope, function);
                var body = binder.statements.BindStatement(function.Declaration.Body);
                var loweredBody = Lowerer.Lower(body);

                if (function.Type != TypeSymbol.Void && !IsIteratorReturnType(function.Type) && !ControlFlowGraph.AllPathsReturn(loweredBody))
                {
                    binder.Diagnostics.ReportAllPathsMustReturn(function.Declaration.Identifier.Location);
                }

                // ADR-0060 items #4/#5: out-parameter definite-assignment and
                // 'ref'-arg unassigned-before-read checks.
                RefKindDefiniteAssignmentAnalyzer.Analyze(loweredBody, function, binder.Diagnostics);

                functionBodies.Add(function, loweredBody);

                diagnostics.AddRange(binder.Diagnostics);
            }

            scope = scope.Previous;
        }

        // Phase 3.B.3 sub-step 2b: bind class method bodies. Methods are not
        // in globalScope.Functions (they're addressed via the dot operator),
        // so we walk Structs explicitly here.
        foreach (var structSym in globalScope.Structs)
        {
            if (structSym.Methods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var method in structSym.Methods)
            {
                var binder = new Binder(parentScope, method);
                var body = binder.statements.BindStatement(method.Declaration.Body);
                var loweredBody = Lowerer.Lower(body, structSym);

                if (method.Type != TypeSymbol.Void && !IsIteratorReturnType(method.Type) && !ControlFlowGraph.AllPathsReturn(loweredBody))
                {
                    binder.Diagnostics.ReportAllPathsMustReturn(method.Declaration.Identifier.Location);
                }

                functionBodies.Add(method, loweredBody);
                diagnostics.AddRange(binder.Diagnostics);
            }
        }

        // Issue #306: bind standalone user-defined constructor bodies. Like
        // instance methods, the constructor body sees `this`, the constructor
        // parameters, and the class's fields (via bare names). The body is keyed
        // in functionBodies by the constructor's underlying FunctionSymbol.
        // ADR-0063 §9: a class may declare multiple init(...) constructors; each
        // body is bound independently.
        foreach (var structSym in globalScope.Structs)
        {
            if (structSym.ExplicitConstructors.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var ctor in structSym.ExplicitConstructors)
            {
                var ctorBinder = new Binder(parentScope, ctor.Function);
                var ctorBody = ctorBinder.statements.BindStatement(ctor.Declaration.Body);
                var ctorLoweredBody = Lowerer.Lower(ctorBody, structSym);
                functionBodies.Add(ctor.Function, ctorLoweredBody);
                diagnostics.AddRange(ctorBinder.Diagnostics);
            }
        }

        // ADR-0051: bind computed property accessor bodies. These are analogous
        // to method bodies but hang off PropertySymbol.GetterSymbol/SetterSymbol.
        foreach (var structSym in globalScope.Structs)
        {
            if (!structSym.Properties.IsDefaultOrEmpty)
            {
                foreach (var prop in structSym.Properties)
                {
                    if (prop.IsAutoProperty)
                    {
                        continue;
                    }

                    if (prop.GetterSymbol != null && prop.GetterBodySyntax != null)
                    {
                        var binder = new Binder(parentScope, prop.GetterSymbol);
                        var body = binder.statements.BindStatement(prop.GetterBodySyntax);
                        var loweredBody = Lowerer.Lower(body, structSym);

                        if (!ControlFlowGraph.AllPathsReturn(loweredBody))
                        {
                            binder.Diagnostics.ReportAllPathsMustReturn(prop.GetterBodySyntax.OpenBraceToken.Location);
                        }

                        functionBodies.Add(prop.GetterSymbol, loweredBody);
                        diagnostics.AddRange(binder.Diagnostics);
                    }

                    if (prop.SetterSymbol != null && prop.SetterBodySyntax != null)
                    {
                        var binder = new Binder(parentScope, prop.SetterSymbol);
                        var body = binder.statements.BindStatement(prop.SetterBodySyntax);
                        var loweredBody = Lowerer.Lower(body, structSym);
                        functionBodies.Add(prop.SetterSymbol, loweredBody);
                        diagnostics.AddRange(binder.Diagnostics);
                    }
                }
            }

            // ADR-0052: bind explicit event accessor bodies (add/remove/raise).
            if (!structSym.Events.IsDefaultOrEmpty)
            {
                foreach (var ev in structSym.Events)
                {
                    if (ev.IsFieldLike)
                    {
                        continue;
                    }

                    if (ev.AddMethodSymbol != null && ev.AddBodySyntax != null)
                    {
                        var binder = new Binder(parentScope, ev.AddMethodSymbol);
                        var body = binder.statements.BindStatement(ev.AddBodySyntax);
                        var loweredBody = Lowerer.Lower(body, structSym);
                        functionBodies.Add(ev.AddMethodSymbol, loweredBody);
                        diagnostics.AddRange(binder.Diagnostics);
                    }

                    if (ev.RemoveMethodSymbol != null && ev.RemoveBodySyntax != null)
                    {
                        var binder = new Binder(parentScope, ev.RemoveMethodSymbol);
                        var body = binder.statements.BindStatement(ev.RemoveBodySyntax);
                        var loweredBody = Lowerer.Lower(body, structSym);
                        functionBodies.Add(ev.RemoveMethodSymbol, loweredBody);
                        diagnostics.AddRange(binder.Diagnostics);
                    }

                    // Issue #257: bind raise accessor body.
                    if (ev.RaiseMethodSymbol != null && ev.RaiseBodySyntax != null)
                    {
                        var binder = new Binder(parentScope, ev.RaiseMethodSymbol);
                        var body = binder.statements.BindStatement(ev.RaiseBodySyntax);
                        var loweredBody = Lowerer.Lower(body, structSym);
                        functionBodies.Add(ev.RaiseMethodSymbol, loweredBody);
                        diagnostics.AddRange(binder.Diagnostics);
                    }
                }
            }
        }

        // Issue #263: bind static property accessor bodies declared in `shared` blocks.
        foreach (var structSym in globalScope.Structs)
        {
            if (structSym.StaticProperties.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var prop in structSym.StaticProperties)
            {
                if (prop.IsAutoProperty)
                {
                    continue;
                }

                if (prop.GetterSymbol != null && prop.GetterBodySyntax != null)
                {
                    var binder = new Binder(parentScope, prop.GetterSymbol);
                    var body = binder.statements.BindStatement(prop.GetterBodySyntax);
                    var loweredBody = Lowerer.Lower(body, structSym);

                    if (!ControlFlowGraph.AllPathsReturn(loweredBody))
                    {
                        binder.Diagnostics.ReportAllPathsMustReturn(prop.GetterBodySyntax.OpenBraceToken.Location);
                    }

                    functionBodies.Add(prop.GetterSymbol, loweredBody);
                    diagnostics.AddRange(binder.Diagnostics);
                }

                if (prop.SetterSymbol != null && prop.SetterBodySyntax != null)
                {
                    var binder = new Binder(parentScope, prop.SetterSymbol);
                    var body = binder.statements.BindStatement(prop.SetterBodySyntax);
                    var loweredBody = Lowerer.Lower(body, structSym);
                    functionBodies.Add(prop.SetterSymbol, loweredBody);
                    diagnostics.AddRange(binder.Diagnostics);
                }
            }
        }

        // Issue #263: bind static event accessor bodies declared in `shared` blocks.
        foreach (var structSym in globalScope.Structs)
        {
            if (structSym.StaticEvents.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var ev in structSym.StaticEvents)
            {
                if (ev.IsFieldLike)
                {
                    continue;
                }

                if (ev.AddMethodSymbol != null && ev.AddBodySyntax != null)
                {
                    var binder = new Binder(parentScope, ev.AddMethodSymbol);
                    var body = binder.statements.BindStatement(ev.AddBodySyntax);
                    var loweredBody = Lowerer.Lower(body, structSym);
                    functionBodies.Add(ev.AddMethodSymbol, loweredBody);
                    diagnostics.AddRange(binder.Diagnostics);
                }

                if (ev.RemoveMethodSymbol != null && ev.RemoveBodySyntax != null)
                {
                    var binder = new Binder(parentScope, ev.RemoveMethodSymbol);
                    var body = binder.statements.BindStatement(ev.RemoveBodySyntax);
                    var loweredBody = Lowerer.Lower(body, structSym);
                    functionBodies.Add(ev.RemoveMethodSymbol, loweredBody);
                    diagnostics.AddRange(binder.Diagnostics);
                }

                // Issue #257: bind raise accessor body for static events.
                if (ev.RaiseMethodSymbol != null && ev.RaiseBodySyntax != null)
                {
                    var binder = new Binder(parentScope, ev.RaiseMethodSymbol);
                    var body = binder.statements.BindStatement(ev.RaiseBodySyntax);
                    var loweredBody = Lowerer.Lower(body, structSym);
                    functionBodies.Add(ev.RaiseMethodSymbol, loweredBody);
                    diagnostics.AddRange(binder.Diagnostics);
                }
            }
        }

        // ADR-0053 Phase D: bind static method bodies declared in `shared` blocks.
        foreach (var structSym in globalScope.Structs)
        {
            if (structSym.StaticMethods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var method in structSym.StaticMethods)
            {
                if (method.Declaration == null)
                {
                    continue;
                }

                var binder = new Binder(parentScope, method);
                var body = binder.statements.BindStatement(method.Declaration.Body);
                var loweredBody = Lowerer.Lower(body, structSym);

                if (method.Type != TypeSymbol.Void && !IsIteratorReturnType(method.Type) && !ControlFlowGraph.AllPathsReturn(loweredBody))
                {
                    binder.Diagnostics.ReportAllPathsMustReturn(method.Declaration.Identifier.Location);
                }

                functionBodies.Add(method, loweredBody);
                diagnostics.AddRange(binder.Diagnostics);
            }
        }

        var statement = Lowerer.Lower(new BoundBlockStatement(null, globalScope.Statements));

        // If the entry point is the synthesized top-level function, its body is
        // the lowered top-level statements block. Register it under EntryPoint so
        // the emitter sees a uniform "Functions[EntryPoint]" view.
        if (globalScope.EntryPoint != null && globalScope.EntryPoint.Declaration == null)
        {
            functionBodies[globalScope.EntryPoint] = statement;
        }

        // #191: surface user-declared top-level var/let/const so the emitter can
        // round-trip them as CLR static fields on <Program>. Filter out
        // compiler-synthesized temps (e.g. tuple-destructuring "<>m_..." vars)
        // by the C#-style "<>" name prefix — those remain local-slot scoped.
        var globals = globalScope.Variables
            .OfType<GlobalVariableSymbol>()
            .Where(g => !g.Name.StartsWith("<>"))
            .ToImmutableArray();

        return new BoundProgram(globalScope.Package, globalScope.Packages, diagnostics.ToImmutable(), functionBodies.ToImmutable(), globalScope.EntryPoint, statement, globalScope.Structs, globalScope.Interfaces, globalScope.Enums, globals, globalScope.Delegates)
        {
            Imports = globalScope.Imports,
        };
    }

    /// <summary>
    /// Speculatively binds <paramref name="expression"/> against the program's
    /// scope to infer its <see cref="TypeSymbol"/>, discarding any diagnostics.
    /// Used by the language server to offer member completions on arbitrary
    /// receiver expressions (e.g. <c>(a + b).</c>, <c>foo().</c>, <c>arr[0].</c>,
    /// <c>a.b.</c>). Top-level variables are reachable through the reconstructed
    /// parent scope; locals/parameters of an enclosing function must be supplied
    /// via <paramref name="additionalLocals"/>.
    /// </summary>
    /// <param name="globalScope">The bound global scope of the compilation.</param>
    /// <param name="references">The reference resolver supplying imported types.</param>
    /// <param name="containingFunction">The function enclosing the expression, or <c>null</c> for top-level statements.</param>
    /// <param name="additionalLocals">In-scope locals/parameters to declare before binding, or <c>null</c>.</param>
    /// <param name="expression">The receiver expression to infer a type for.</param>
    /// <returns>The inferred non-error, non-void type, or <c>null</c> when inference fails.</returns>
    internal static TypeSymbol TryInferExpressionType(
        BoundGlobalScope globalScope,
        ReferenceResolver references,
        FunctionSymbol containingFunction,
        IEnumerable<VariableSymbol> additionalLocals,
        ExpressionSyntax expression)
    {
        if (globalScope == null || expression == null)
        {
            return null;
        }

        try
        {
            var parentScope = CreateParentScope(globalScope, references, globalScope.PreprocessorSymbols);
            var binder = new Binder(parentScope, containingFunction);

            if (additionalLocals != null)
            {
                foreach (var local in additionalLocals)
                {
                    if (local != null)
                    {
                        // Speculative binding: collisions with already-declared
                        // parameters are expected and harmless (TryDeclareVariable
                        // simply reports false).
                        binder.scope.TryDeclareVariable(local);
                    }
                }
            }

            // The binder writes any diagnostics into its own throwaway bag, so
            // speculative binding never leaks errors into the open document.
            var bound = binder.BindExpression(expression);
            var type = bound?.Type;
            return type == null || ReferenceEquals(type, TypeSymbol.Error) || ReferenceEquals(type, TypeSymbol.Void)
                ? null
                : type;
        }
        catch (Exception)
        {
            // Inference must never throw into the editor pipeline.
            return null;
        }
    }

    private static BoundScope CreateParentScope(BoundGlobalScope previous, ReferenceResolver references, ImmutableHashSet<string> preprocessorSymbols)
    {
        var stack = new Stack<BoundGlobalScope>();
        while (previous != null)
        {
            stack.Push(previous);
            previous = previous.Previous;
        }

        var parent = CreateRootScope(references, preprocessorSymbols);

        while (stack.Count > 0)
        {
            previous = stack.Pop();
            var scope = new BoundScope(parent);

            foreach (var i in previous.Imports)
            {
                scope.TryImport(i);
            }

            foreach (var alias in previous.TypeAliases)
            {
                scope.TryDeclareTypeAlias(alias.Key, alias.Value);
            }

            foreach (var f in previous.Functions)
            {
                scope.TryDeclareFunction(f);
            }

            foreach (var v in previous.Variables)
            {
                scope.TryDeclareVariable(v);
            }

            parent = scope;
        }

        return parent;
    }

    private static BoundScope CreateRootScope(ReferenceResolver references, ImmutableHashSet<string> preprocessorSymbols)
    {
        var result = new BoundScope(parent: null, references: references, preprocessorSymbols: preprocessorSymbols);

        foreach (var f in BuiltinFunctions.GetAll())
        {
            result.TryDeclareFunction(f);
        }

        return result;
    }

    private void BindImport(ImportSyntax import)
    {
        var sb = new StringBuilder();
        foreach (var i in import.IdentifiersWithDots)
        {
            sb.Append(i.Text);
        }

        var targetPath = sb.ToString();
        var localName = import.AliasIdentifier?.Text ?? targetPath;
        var importSymbol = new ImportSymbol(localName, targetPath, import);
        AttachDocumentation(importSymbol, import);
        scope.TryImport(importSymbol);
    }

    private static bool ClrTypesEquivalent(System.Type a, System.Type b)
        => ClrTypeUtilities.AreSame(a, b);

    private static bool IsPrimitiveTypeName(string name)
    {
        switch (name)
        {
            case "bool":
            case "uint8":
            case "int8":
            case "int16":
            case "uint16":
            case "int32":
            case "uint32":
            case "int64":
            case "uint64":
            case "nint":
            case "nuint":
            case "float32":
            case "float64":
            case "decimal":
            case "char":
            case "string":
            case "object":
                return true;
            default:
                return false;
        }
    }

    private static Accessibility ResolveAccessibility(SyntaxToken modifier)
    {
        if (modifier == null)
        {
            return Accessibility.Public;
        }

        switch (modifier.Kind)
        {
            case SyntaxKind.PublicKeyword:
                return Accessibility.Public;
            case SyntaxKind.InternalKeyword:
                return Accessibility.Internal;
            case SyntaxKind.PrivateKeyword:
                return Accessibility.Private;
            default:
                return Accessibility.Public;
        }
    }

    private TypeSymbol BindNonNullableTypeClause(TypeClauseSyntax syntax)
    {
        if (syntax == null)
        {
            return null;
        }

        if (syntax.IsFunction)
        {
            // Phase 4.7: function-type clause `func(T1, T2, ...) R?`.
            // ADR-0043: `async func(P) R` aliases to `func(P) Task[R]` (with
            // carve-outs for void → Task and IAsyncEnumerable[T] → unchanged).
            var paramTypes = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.FunctionParameterTypes.Count);
            for (var i = 0; i < syntax.FunctionParameterTypes.Count; i++)
            {
                var pt = BindTypeClause(syntax.FunctionParameterTypes[i]);
                if (pt == null)
                {
                    return null;
                }

                paramTypes.Add(pt);
            }

            var ret = syntax.ReturnTypeClause != null ? BindTypeClause(syntax.ReturnTypeClause) : TypeSymbol.Void;
            if (ret == null)
            {
                return null;
            }

            if (syntax.IsAsyncFunction)
            {
                if (IsTaskShapedReturn(ret))
                {
                    Diagnostics.ReportAsyncFunctionTypeClauseHasExplicitTaskReturn(
                        syntax.ReturnTypeClause.Location,
                        ret.Name);
                    return null;
                }

                // ADR-0041 iterator carve-out — same logic as
                // BindReturnTypeClause(isAsync=true) at function declarations.
                if (ret is SequenceTypeSymbol seq)
                {
                    ret = AsyncSequenceTypeSymbol.Get(seq.ElementType);
                }
                else if (ret is NullableTypeSymbol nt && nt.UnderlyingType is SequenceTypeSymbol innerSeq)
                {
                    ret = NullableTypeSymbol.Get(AsyncSequenceTypeSymbol.Get(innerSeq.ElementType));
                }
                else if (!IsAsyncIteratorReturnType(ret))
                {
                    ret = lambdas.WrapAsTask(ret);
                }
            }

            return FunctionTypeSymbol.Get(paramTypes.MoveToImmutable(), ret ?? TypeSymbol.Void);
        }

        if (syntax.IsTuple)
        {
            // Phase 4.5: tuple type clause `(T1, T2, ...)`.
            if (syntax.TupleElements.Count < 2)
            {
                Diagnostics.ReportUnexpectedToken(syntax.CloseParenToken.Location, syntax.CloseParenToken.Kind, SyntaxKind.IdentifierToken);
                return null;
            }

            var elements = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.TupleElements.Count);
            for (var i = 0; i < syntax.TupleElements.Count; i++)
            {
                var elementType = BindTypeClause(syntax.TupleElements[i]);
                if (elementType == null)
                {
                    return null;
                }

                elements.Add(elementType);
            }

            return TupleTypeSymbol.Get(elements.MoveToImmutable());
        }

        if (syntax.IsMap)
        {
            // Phase 3.A.4: map type clause `map[K]V`.
            var keyType = BindTypeClause(syntax.MapKeyType);
            var valueType = BindTypeClause(syntax.MapValueType);
            if (keyType == null || valueType == null)
            {
                return null;
            }

            return MapTypeSymbol.Get(keyType, valueType);
        }

        if (syntax.IsChannel)
        {
            // Phase 5.4 / ADR-0022: channel type clause `chan T`.
            var elementType = BindTypeClause(syntax.ChanElementType);
            if (elementType == null)
            {
                return null;
            }

            return ChannelTypeSymbol.Get(elementType);
        }

        // ADR-0040: sequence type clause `sequence[T]`.
        // ADR-0042: `async sequence[T]` resolves to IAsyncEnumerable[T] in any
        // type-clause position; the unmodified `sequence[T]` stays IEnumerable[T]
        // (with the ADR-0041 implicit swap applied separately at function
        // return-type binding sites).
        if (syntax.IsSequence)
        {
            var elementType = BindTypeClause(syntax.SequenceElementType);
            if (elementType == null)
            {
                return null;
            }

            if (syntax.IsAsyncSequence)
            {
                return AsyncSequenceTypeSymbol.Get(elementType);
            }

            return SequenceTypeSymbol.Get(elementType);
        }

        // ADR-0039: pointer type clause `*T`.
        if (syntax.IsPointer)
        {
            var pointeeType = BindTypeClause(syntax.PointerPointeeType);
            if (pointeeType == null)
            {
                return null;
            }

            return ByRefTypeSymbol.Get(pointeeType);
        }

        // Phase 4.4 / ADR-0020: if the type clause carries a type-argument list,
        // first try to resolve the identifier as an open generic CLR type via
        // imports (mangled name `Name`N`). This lets users write `List[int]` or
        // `Dictionary[string, int]` directly. Falls through to the regular
        // identifier lookup (covering GSharp generic interfaces/structs) when
        // the import-search does not produce a match.
        // Issue #526: only enter this path for the simple single-identifier form;
        // dotted-qualifier names (`Outer.Inner`) are routed through
        // <see cref="BindQualifiedTypeName"/> below, which handles the
        // arity-mangled lookup for a generic NESTED type itself.
        if (!syntax.HasQualifier &&
            syntax.HasTypeArguments &&
            scope.TryLookupImportedGenericClass(syntax.Identifier.Text, syntax.TypeArguments.Count, out var clrOpenType))
        {
            var clrArgs = new System.Type[syntax.TypeArguments.Count];
            var symbolicArgs = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.TypeArguments.Count);
            var hasTypeParameterArg = false;
            for (var i = 0; i < syntax.TypeArguments.Count; i++)
            {
                var ta = BindTypeClause(syntax.TypeArguments[i]);
                if (ta == null)
                {
                    return null;
                }

                symbolicArgs.Add(ta);

                // Issue #367: a by-ref-like (`ref struct`) type cannot be used as
                // a generic type argument (e.g. `List[Span[int32]]`); the CLR
                // forbids constructing a generic type over a by-ref-like type.
                if (TypeSymbol.IsByRefLike(ta))
                {
                    var taLocation = syntax.TypeArguments[i].Identifier?.Location ?? syntax.Identifier.Location;
                    Diagnostics.ReportByRefLikeEscape(taLocation, ta, "be used as a generic type argument");
                    return null;
                }

                // #313: an in-scope generic type parameter used as a type
                // argument (e.g. `List[T]` inside `func First[T](...)`) is a
                // valid type in any position. Under the type-erased generic
                // model (ADR-0004; type parameters encode as System.Object at
                // emit) the type argument projects onto `object` for the closed
                // CLR shape so member / index / conversion resolution keeps
                // working, while the symbolic `[T]` is preserved on the result
                // for inference, substitution, and erased emit.
                if (TypeSymbol.ContainsTypeParameter(ta))
                {
                    hasTypeParameterArg = true;
                    clrArgs[i] = typeof(object);
                    continue;
                }

                if (ta.ClrType == null)
                {
                    Diagnostics.ReportTypeNotGeneric(syntax.TypeArguments[i].Identifier?.Location ?? syntax.Identifier.Location, ta.Name);
                    return null;
                }

                // Project host CLR type arguments onto the resolver's reference
                // set so they share clrOpenType's load context (its
                // MetadataLoadContext when references are supplied via /r:),
                // which MakeGenericType requires.
                // Issue #530: use ResolveClrTypeForGenericArg so that
                // `int32?` resolves to `Nullable<int>` (not bare `int`).
                clrArgs[i] = ResolveClrTypeForGenericArg(ta) ?? scope.References.MapClrTypeToReferences(ta.ClrType);
            }

            try
            {
                var closed = clrOpenType.MakeGenericType(clrArgs);
                if (hasTypeParameterArg)
                {
                    // #313: keep the symbolic `[T]` arguments alongside the
                    // type-erased closed CLR shape so call-site inference and
                    // return-type substitution can recover the type parameter.
                    return ImportedTypeSymbol.GetConstructed(closed, clrOpenType, symbolicArgs.MoveToImmutable());
                }

                return TypeSymbol.FromClrType(closed);
            }
            catch (System.ArgumentException)
            {
                Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.Identifier.Text);
                return null;
            }
        }

        TypeSymbol element;
        if (syntax.HasQualifier)
        {
            // Issue #526: dotted-qualifier name `Outer.Inner` (or `A.B.C`).
            // Resolves to a (possibly nested) CLR type, honoring imports for
            // the outer prefix and `Type.GetNestedType` for the remaining
            // segments. When the deepest segment is generic and the clause
            // carries a type-argument list, `BindQualifiedTypeName` constructs
            // the closed type via `MakeGenericType`.
            element = BindQualifiedTypeName(syntax);
            if (element == null)
            {
                return null;
            }

            // ADR-0047 §6 / #175: obsolete-use reporting still applies.
            ReportObsoleteUseIfApplicable(syntax.Identifier.Location, element, element.Name);

            // BindQualifiedTypeName already consumed `syntax.TypeArguments` if
            // there was an arity match; skip the single-identifier generic
            // construction branch below by falling straight through to the
            // array-suffix path at the end of this method.
        }
        else
        {
            element = LookupType(syntax.Identifier.Text);
            if (element == null)
            {
                Diagnostics.ReportUndefinedType(syntax.Identifier.Location, syntax.Identifier.Text);
                return null;
            }

            // ADR-0047 §6 / #175: report obsolete-use for any named struct,
            // class, interface, or enum reference appearing in type position
            // (parameter types, return types, field types, generic-argument
            // positions, type aliases, etc.).
            ReportObsoleteUseIfApplicable(syntax.Identifier.Location, element, element.Name);

            // Phase 4.3c / ADR-0020: handle generic type construction `Foo[T1, T2]` in
            // type position (currently interfaces; structs follow up later).
            if (syntax.HasTypeArguments)
            {
                var typeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.TypeArguments.Count);
                for (var i = 0; i < syntax.TypeArguments.Count; i++)
                {
                    var ta = BindTypeClause(syntax.TypeArguments[i]);
                    if (ta == null)
                    {
                        return null;
                    }

                    // Issue #367: by-ref-like (`ref struct`) types are not permitted
                    // as generic type arguments to a user-defined generic type.
                    if (TypeSymbol.IsByRefLike(ta))
                    {
                        var taLocation = syntax.TypeArguments[i].Identifier?.Location ?? syntax.Identifier.Location;
                        Diagnostics.ReportByRefLikeEscape(taLocation, ta, "be used as a generic type argument");
                        return null;
                    }

                    typeArgsBuilder.Add(ta);
                }

                var typeArgs = typeArgsBuilder.MoveToImmutable();
                if (element is InterfaceSymbol iface)
                {
                    if (!iface.IsGenericDefinition)
                    {
                        Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.Identifier.Text);
                        return null;
                    }

                    if (iface.TypeParameters.Length != typeArgs.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(syntax.Identifier.Location, syntax.Identifier.Text, iface.TypeParameters.Length, typeArgs.Length);
                        return null;
                    }

                    element = InterfaceSymbol.Construct(iface, typeArgs);
                }
                else if (element is StructSymbol genericStruct)
                {
                    if (!genericStruct.IsGenericDefinition)
                    {
                        Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.Identifier.Text);
                        return null;
                    }

                    if (genericStruct.TypeParameters.Length != typeArgs.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(syntax.Identifier.Location, syntax.Identifier.Text, genericStruct.TypeParameters.Length, typeArgs.Length);
                        return null;
                    }

                    element = StructSymbol.Construct(genericStruct, typeArgs);
                }
                else
                {
                    Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.Identifier.Text);
                    return null;
                }
            }
        }

        if (!syntax.IsArray)
        {
            return element;
        }

        if (syntax.IsSlice)
        {
            return SliceTypeSymbol.Get(element);
        }

        if (!int.TryParse(syntax.LengthToken.Text, out var length) || length < 0)
        {
            Diagnostics.ReportInvalidArrayLength(syntax.LengthToken.Location, syntax.LengthToken.Text);
            return null;
        }

        return ArrayTypeSymbol.Get(element, length);
    }

    private TypeSymbol BindTypeClause(TypeClauseSyntax syntax)
    {
        var bound = BindNonNullableTypeClause(syntax);
        if (bound == null || !syntax.IsNullable)
        {
            return bound;
        }

        return NullableTypeSymbol.Get(bound);
    }

    /// <summary>
    /// Issue #526: resolves a dotted-qualifier type clause (<c>Outer.Inner</c>,
    /// <c>A.B.C</c>) to a <see cref="TypeSymbol"/> wrapping a (possibly nested)
    /// CLR type.
    /// <para>
    /// Strategy: enumerate "split points" between an outer prefix that is a
    /// fully-qualified type name and the remaining segments that name nested
    /// types of that outer. The longest viable outer prefix wins, which lets
    /// callers write both <c>Outer.Inner</c> (with <c>import Probe.CSharp</c>
    /// providing the namespace prefix) and the fully-qualified
    /// <c>Probe.CSharp.Outer.Inner</c>. Type arguments on the clause attach to
    /// the deepest (last) segment so a nested generic such as
    /// <c>Outer.Generic[int]</c> resolves to the constructed
    /// <c>Outer.Generic`1</c> closed type.
    /// </para>
    /// <para>
    /// TODO(issue-526): per-segment type-argument syntax (e.g.
    /// <c>Outer[T].Inner</c>) is not yet expressible in the grammar — a single
    /// trailing <c>[…]</c> attaches to the last segment only. Adding mid-chain
    /// type-argument lists requires extending <see cref="TypeClauseSyntax"/>
    /// and the parser to record arguments per qualifier segment; deferred to a
    /// follow-up while keeping the non-generic and deepest-generic cases
    /// working end-to-end.
    /// </para>
    /// </summary>
    private TypeSymbol BindQualifiedTypeName(TypeClauseSyntax syntax)
    {
        var totalSegments = 1 + syntax.QualifierIdentifierTokens.Length;
        var segmentTexts = new string[totalSegments];
        segmentTexts[0] = syntax.Identifier.Text;
        for (var i = 0; i < syntax.QualifierIdentifierTokens.Length; i++)
        {
            segmentTexts[1 + i] = syntax.QualifierIdentifierTokens[i].Text;
        }

        var targetArity = syntax.HasTypeArguments ? syntax.TypeArguments.Count : 0;

        // Greedy: prefer the longest outer prefix that resolves to a real type,
        // then walk the remaining segments as nested types. Going longest-first
        // lets a fully-qualified `Probe.CSharp.Outer` win without being misled
        // by a single-name `Probe` that happens to exist somewhere.
        for (var outerLen = totalSegments; outerLen >= 1; outerLen--)
        {
            var clrType = TryResolveOuterPrefix(segmentTexts, outerLen);
            if (clrType == null)
            {
                continue;
            }

            // Walk remaining segments as nested types. For the deepest segment,
            // if the clause has type arguments, prefer the arity-mangled
            // generic nested type so `Outer.Generic[T]` matches `Outer+Generic`1`.
            var walked = WalkNestedSegments(clrType, segmentTexts, outerLen, totalSegments, targetArity);
            if (walked != null)
            {
                return ConstructIfGeneric(walked, syntax, targetArity);
            }
        }

        // Could not resolve. Pinpoint the failing segment so the diagnostic is
        // actionable: if even the outermost simple name doesn't exist, report
        // a regular "undefined type". Otherwise walk from the outermost
        // resolvable segment and emit "Outer does not contain a nested type
        // 'X'" for the first failing segment.
        var outermost = LookupType(syntax.Identifier.Text);
        if (outermost == null)
        {
            Diagnostics.ReportUndefinedType(syntax.Identifier.Location, syntax.DottedName);
            return null;
        }

        var current = outermost.ClrType;
        if (current == null)
        {
            // Outer is a built-in / GSharp-defined type with no CLR
            // representation reachable here; just report it as undefined.
            Diagnostics.ReportUndefinedType(syntax.Identifier.Location, syntax.DottedName);
            return null;
        }

        var lastGoodName = syntax.Identifier.Text;
        for (var i = 0; i < syntax.QualifierIdentifierTokens.Length; i++)
        {
            var segmentText = syntax.QualifierIdentifierTokens[i].Text;
            var isLast = i == syntax.QualifierIdentifierTokens.Length - 1;
            Type next = null;
            if (isLast && targetArity > 0)
            {
                scope.References.TryResolveNestedType(current, segmentText + "`" + targetArity, out next);
            }

            if (next == null)
            {
                scope.References.TryResolveNestedType(current, segmentText, out next);
            }

            if (next == null)
            {
                Diagnostics.ReportUndefinedNestedType(
                    syntax.QualifierIdentifierTokens[i].Location,
                    lastGoodName,
                    segmentText);
                return null;
            }

            current = next;
            lastGoodName = lastGoodName + "." + segmentText;
        }

        // Walk succeeded but ConstructIfGeneric must have failed; surface a
        // generic-mismatch diagnostic as a fallback.
        Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.DottedName);
        return null;
    }

    /// <summary>
    /// Issue #526: resolves the first <paramref name="outerLen"/> segments of
    /// <paramref name="segmentTexts"/> joined by <c>.</c> to a single CLR
    /// type. Honors aliases and the active import set for one-segment
    /// prefixes, and the active import set as a namespace prefix for
    /// multi-segment prefixes.
    /// </summary>
    private Type TryResolveOuterPrefix(string[] segmentTexts, int outerLen)
    {
        if (outerLen == 1)
        {
            var symbol = LookupType(segmentTexts[0]);
            return symbol?.ClrType;
        }

        var prefix = string.Join(".", segmentTexts, 0, outerLen);
        if (scope.References.TryResolveType(prefix, out var direct))
        {
            return direct;
        }

        foreach (var import in scope.GetDeclaredImports())
        {
            if (scope.References.TryResolveType(import.Target + "." + prefix, out var viaImport))
            {
                return viaImport;
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #526: walks <paramref name="segmentTexts"/> starting at
    /// <paramref name="start"/>, treating each remaining segment as a nested
    /// type on <paramref name="container"/>. For the deepest segment, when
    /// <paramref name="targetArity"/> &gt; 0 the arity-mangled name
    /// (<c>Name`N</c>) is preferred so a nested generic such as
    /// <c>Outer.Generic[T]</c> matches.
    /// Returns <c>null</c> when any segment fails to resolve.
    /// </summary>
    private Type WalkNestedSegments(Type container, string[] segmentTexts, int start, int end, int targetArity)
    {
        var current = container;
        for (var i = start; i < end; i++)
        {
            var name = segmentTexts[i];
            var isLast = i == end - 1;
            Type next = null;
            if (isLast && targetArity > 0)
            {
                scope.References.TryResolveNestedType(current, name + "`" + targetArity, out next);
            }

            if (next == null)
            {
                scope.References.TryResolveNestedType(current, name, out next);
            }

            if (next == null)
            {
                return null;
            }

            current = next;
        }

        return current;
    }

    /// <summary>
    /// Issue #526: when the resolved CLR <paramref name="clrType"/> is a
    /// generic type definition and the clause carries a type-argument list,
    /// binds each argument and calls <see cref="Type.MakeGenericType(Type[])"/>
    /// to produce the constructed type. Non-generic resolutions pass through
    /// unchanged. A type-arguments-on-a-non-generic mismatch surfaces a
    /// <c>ReportTypeNotGeneric</c> diagnostic.
    /// </summary>
    private TypeSymbol ConstructIfGeneric(Type clrType, TypeClauseSyntax syntax, int targetArity)
    {
        if (targetArity == 0)
        {
            return TypeSymbol.FromClrType(clrType);
        }

        if (!clrType.IsGenericTypeDefinition)
        {
            Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.DottedName);
            return null;
        }

        var clrArgs = new Type[targetArity];
        var symbolicArgs = ImmutableArray.CreateBuilder<TypeSymbol>(targetArity);
        var hasTypeParameterArg = false;
        for (var i = 0; i < targetArity; i++)
        {
            var ta = BindTypeClause(syntax.TypeArguments[i]);
            if (ta == null)
            {
                return null;
            }

            symbolicArgs.Add(ta);

            // Issue #367: by-ref-like types cannot serve as generic arguments.
            if (TypeSymbol.IsByRefLike(ta))
            {
                var taLocation = syntax.TypeArguments[i].Identifier?.Location ?? syntax.Identifier.Location;
                Diagnostics.ReportByRefLikeEscape(taLocation, ta, "be used as a generic type argument");
                return null;
            }

            // #313: in-scope type parameters project onto System.Object under
            // the type-erased generic model so the closed CLR shape is well
            // formed while the symbolic argument is preserved alongside.
            if (TypeSymbol.ContainsTypeParameter(ta))
            {
                hasTypeParameterArg = true;
                clrArgs[i] = typeof(object);
                continue;
            }

            if (ta.ClrType == null)
            {
                Diagnostics.ReportTypeNotGeneric(syntax.TypeArguments[i].Identifier?.Location ?? syntax.Identifier.Location, ta.Name);
                return null;
            }

            clrArgs[i] = ResolveClrTypeForGenericArg(ta) ?? scope.References.MapClrTypeToReferences(ta.ClrType);
        }

        try
        {
            var closed = clrType.MakeGenericType(clrArgs);
            if (hasTypeParameterArg)
            {
                return ImportedTypeSymbol.GetConstructed(closed, clrType, symbolicArgs.MoveToImmutable());
            }

            return TypeSymbol.FromClrType(closed);
        }
        catch (System.ArgumentException)
        {
            Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.DottedName);
            return null;
        }
    }

    /// <summary>
    /// ADR-0041: binds the return-type clause of a function (declaration,
    /// method, extension, or lambda). When <paramref name="isAsync"/> is
    /// <c>true</c> and the clause is the top-level <c>sequence[T]</c> alias
    /// (optionally nullable), the alias resolves to
    /// <see cref="AsyncSequenceTypeSymbol"/> (i.e. <c>IAsyncEnumerable[T]</c>)
    /// rather than the synchronous <see cref="SequenceTypeSymbol"/>.
    /// In every other position — parameter types, locals, generic arguments,
    /// nested type clauses — <c>sequence[T]</c> continues to mean
    /// <c>IEnumerable[T]</c> (ADR-0040).
    /// </summary>
    private TypeSymbol BindReturnTypeClause(TypeClauseSyntax syntax, bool isAsync)
    {
        var bound = BindTypeClause(syntax);
        if (!isAsync || bound == null)
        {
            return bound;
        }

        if (bound is SequenceTypeSymbol seq)
        {
            return AsyncSequenceTypeSymbol.Get(seq.ElementType);
        }

        if (bound is NullableTypeSymbol nt && nt.UnderlyingType is SequenceTypeSymbol innerSeq)
        {
            return NullableTypeSymbol.Get(AsyncSequenceTypeSymbol.Get(innerSeq.ElementType));
        }

        return bound;
    }

    private BoundExpression BindExpressionWithNarrowing(ExpressionSyntax syntax, Dictionary<VariableSymbol, TypeSymbol> frame)
    {
        if (frame == null)
        {
            return BindExpression(syntax);
        }

        binderCtx.NarrowedVariables.Add(frame);
        try
        {
            return BindExpression(syntax);
        }
        finally
        {
            binderCtx.NarrowedVariables.RemoveAt(binderCtx.NarrowedVariables.Count - 1);
        }
    }

    private BoundExpression BindSwitchExpression(SwitchExpressionSyntax syntax)
    {
        var discriminant = BindExpression(syntax.Expression);
        var switchType = discriminant.Type;

        if (switchType == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        if (syntax.Arms.Length == 0)
        {
            if (ExhaustivenessAnalyzer.IsExhaustiveDiscriminant(switchType))
            {
                ExhaustivenessAnalyzer.AnalyzeSwitchExpression(
                    syntax.SwitchKeyword.Location,
                    switchType,
                    ImmutableArray<BoundSwitchExpressionArm>.Empty,
                    scope.GetDeclaredStructs(),
                    Diagnostics);
            }
            else
            {
                Diagnostics.ReportSwitchExpressionMissingDefault(syntax.SwitchKeyword.Location);
            }

            return new BoundErrorExpression(null);
        }

        var hasDefault = false;
        var boundArmBuilders = ImmutableArray.CreateBuilder<(SwitchExpressionArmSyntax Syntax, BoundPattern Pattern, BoundExpression Result)>();

        foreach (var armSyntax in syntax.Arms)
        {
            BoundPattern pattern = null;
            if (armSyntax.IsDefault)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(armSyntax.Keyword.Location);
                }

                hasDefault = true;
                var result = BindExpression(armSyntax.Result);
                boundArmBuilders.Add((armSyntax, pattern, result));
                continue;
            }

            scope = new BoundScope(scope);
            pattern = patterns.BindPattern(armSyntax.Value, switchType);
            if (pattern is BoundDiscardPattern)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(armSyntax.Value.Location);
                }

                hasDefault = true;
            }

            var frame = StatementBinder.TryClassifyPatternNarrowing(discriminant, pattern);
            var armResult = BindExpressionWithNarrowing(armSyntax.Result, frame);
            scope = scope.Parent;
            boundArmBuilders.Add((armSyntax, pattern, armResult));
        }

        if (!hasDefault && !ExhaustivenessAnalyzer.IsExhaustiveDiscriminant(switchType))
        {
            Diagnostics.ReportSwitchExpressionMissingDefault(syntax.SwitchKeyword.Location);
        }

        var resultType = boundArmBuilders[0].Result.Type;
        var arms = ImmutableArray.CreateBuilder<BoundSwitchExpressionArm>(boundArmBuilders.Count);
        foreach (var arm in boundArmBuilders)
        {
            var result = arm.Result;
            var conversion = Conversion.Classify(result.Type, resultType);
            if (!conversion.Exists || conversion.IsExplicit)
            {
                if (result.Type != TypeSymbol.Error && resultType != TypeSymbol.Error)
                {
                    Diagnostics.ReportSwitchExpressionArmTypeMismatch(arm.Syntax.Result.Location, result.Type, resultType);
                }

                result = new BoundErrorExpression(null);
            }
            else if (!conversion.IsIdentity)
            {
                result = new BoundConversionExpression(null, resultType, result);
            }

            arms.Add(new BoundSwitchExpressionArm(null, arm.Pattern, result));
        }

        var boundArms = arms.ToImmutable();
        ExhaustivenessAnalyzer.AnalyzeSwitchExpression(
            syntax.SwitchKeyword.Location,
            switchType,
            boundArms,
            scope.GetDeclaredStructs(),
            Diagnostics);

        return new BoundSwitchExpression(null, discriminant, boundArms, resultType);
    }

    private BoundExpression BindMakeChannelExpression(MakeChannelExpressionSyntax syntax)
    {
        // Phase 5.4 / ADR-0022: `make(chan T)` / `make(chan T, capacity)`.
        var typeSymbol = BindTypeClause(syntax.ChannelTypeClause);
        if (typeSymbol is not ChannelTypeSymbol chan)
        {
            return new BoundErrorExpression(null);
        }

        BoundExpression capacity = null;
        if (syntax.Capacity != null)
        {
            capacity = conversions.BindConversion(syntax.Capacity, TypeSymbol.Int32);
        }

        return new BoundMakeChannelExpression(null, chan, capacity);
    }

    private BoundExpression BindTypeOfExpression(TypeOfExpressionSyntax syntax)
    {
        // Issue #143: `typeof(T)` returns System.Type for the referenced type.
        var typeSymbol = BindTypeClause(syntax.TypeClause);
        if (typeSymbol == null || typeSymbol == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var systemType = ImportedTypeSymbol.Get(typeof(Type));
        return new BoundTypeOfExpression(null, typeSymbol, systemType);
    }

    private BoundExpression BindNameOfExpression(NameOfExpressionSyntax syntax)
    {
        // Issue #143: `nameof(expr)` is folded to a compile-time string of
        // the unqualified short name. The argument must be a name reference
        // (identifier, member access, or type). `nameof(this)` / `nameof(it)`
        // are rejected to match C# semantics.
        if (TryExtractNameOfName(syntax.Argument, out var name))
        {
            return new BoundLiteralExpression(null, name);
        }

        Diagnostics.ReportNameOfRequiresNameReference(syntax.Argument.Location);
        return new BoundErrorExpression(null);
    }

    private static bool TryExtractNameOfName(ExpressionSyntax argument, out string name)
    {
        switch (argument)
        {
            case NameExpressionSyntax n:
                {
                    var ident = n.IdentifierToken.Text;
                    if (string.IsNullOrEmpty(ident) || ident == "this" || ident == "it")
                    {
                        name = null;
                        return false;
                    }

                    name = ident;
                    return true;
                }

            case AccessorExpressionSyntax acc when !acc.IsNullConditional:
                return TryExtractNameOfName(acc.RightPart, out name);

            case CallExpressionSyntax call when call.TypeArgumentList != null && call.Arguments.Count == 0:
                // Generic name like `List[int]` parsed as an empty-arg generic
                // call site is treated as a type reference whose short name is
                // the identifier (matches C# `nameof(List<int>)` -> "List").
                name = call.Identifier.Text;
                return !string.IsNullOrEmpty(name);

            case ParenthesizedExpressionSyntax p:
                return TryExtractNameOfName(p.Expression, out name);

            default:
                name = null;
                return false;
        }
    }

    private static bool IsIteratorReturnType(TypeSymbol type)
    {
        if (type == null)
        {
            return false;
        }

        if (type is SequenceTypeSymbol)
        {
            return true;
        }

        var clr = type.ClrType;
        if (clr == null)
        {
            return false;
        }

        if (clr == typeof(System.Collections.IEnumerable) ||
            clr == typeof(System.Collections.IEnumerator))
        {
            return true;
        }

        if (clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var def = clr.GetGenericTypeDefinition();
            if (def == typeof(System.Collections.Generic.IEnumerable<>) ||
                def == typeof(System.Collections.Generic.IEnumerator<>))
            {
                return true;
            }

            // Async iterators: IAsyncEnumerable<T> / IAsyncEnumerator<T>
            if (def.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IAsyncEnumerator`1")
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Checks if the return type is IAsyncEnumerable[T] or IAsyncEnumerator[T].
    /// Functions with such return types are implicitly async iterators and allow
    /// both yield and await without requiring the 'async' keyword.
    /// </summary>
    private static bool IsAsyncIteratorReturnType(TypeSymbol type)
    {
        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return false;
        }

        var def = clr.GetGenericTypeDefinition();
        var fullName = def?.FullName;
        return fullName == "System.Collections.Generic.IAsyncEnumerable`1"
            || fullName == "System.Collections.Generic.IAsyncEnumerator`1";
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="type"/> denotes an
    /// <c>async sequence</c> — i.e. <c>IAsyncEnumerable&lt;T&gt;</c>. Used
    /// by the <c>@EnumeratorCancellation</c> binder check (ADR-0040 /
    /// issue #180): only sequences expose
    /// <c>GetAsyncEnumerator(CancellationToken)</c> so threading a token
    /// through a marked parameter is only meaningful here, not on a bare
    /// <c>IAsyncEnumerator&lt;T&gt;</c>.
    /// </summary>
    private static bool IsAsyncSequenceReturnType(TypeSymbol type)
    {
        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return false;
        }

        var def = clr.GetGenericTypeDefinition();
        return def?.FullName == "System.Collections.Generic.IAsyncEnumerable`1";
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="type"/> already denotes a
    /// Task-shaped awaitable (Task, Task[T], ValueTask, or ValueTask[T]).
    /// Used by the <c>async func(...)</c> type-clause binder (ADR-0043) to
    /// reject explicit Task wrapping where the modifier already implies it.
    /// </summary>
    private static bool IsTaskShapedReturn(TypeSymbol type)
    {
        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        string fullName;
        if (clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            fullName = clr.GetGenericTypeDefinition()?.FullName;
        }
        else
        {
            fullName = clr.FullName;
        }

        return fullName == "System.Threading.Tasks.Task"
            || fullName == "System.Threading.Tasks.Task`1"
            || fullName == "System.Threading.Tasks.ValueTask"
            || fullName == "System.Threading.Tasks.ValueTask`1";
    }

    private BoundExpression BindExpression(ExpressionSyntax syntax, TypeSymbol targetType)
    {
        return conversions.BindConversion(syntax, targetType);
    }

    private BoundExpression BindExpression(ExpressionSyntax syntax, bool canBeVoid = false)
    {
        var result = BindExpressionpublic(syntax);
        if (!canBeVoid && result.Type == TypeSymbol.Void)
        {
            Diagnostics.ReportExpressionMustHaveValue(syntax.Location);
            return new BoundErrorExpression(null);
        }

        return result;
    }

    private BoundExpression BindExpressionpublic(ExpressionSyntax syntax)
    {
        switch (syntax.Kind)
        {
            case SyntaxKind.ParenthesizedExpression:
                return BindParenthesizedExpression((ParenthesizedExpressionSyntax)syntax);
            case SyntaxKind.LiteralExpression:
                return BindLiteralExpression((LiteralExpressionSyntax)syntax);
            case SyntaxKind.InterpolatedStringExpression:
                return BindInterpolatedStringExpression((InterpolatedStringExpressionSyntax)syntax);
            case SyntaxKind.NameExpression:
                return BindNameExpression((NameExpressionSyntax)syntax);
            case SyntaxKind.AssignmentExpression:
                return BindAssignmentExpression((AssignmentExpressionSyntax)syntax);
            case SyntaxKind.UnaryExpression:
                return BindUnaryExpression((UnaryExpressionSyntax)syntax);
            case SyntaxKind.BinaryExpression:
                return BindBinaryExpression((BinaryExpressionSyntax)syntax);
            case SyntaxKind.CallExpression:
                return overloads.BindCallExpression((CallExpressionSyntax)syntax);
            case SyntaxKind.ObjectCreationExpression:
                return BindObjectCreationExpression((ObjectCreationExpressionSyntax)syntax);
            case SyntaxKind.AccessorExpression:
                return BindAccessorExpression((AccessorExpressionSyntax)syntax);
            case SyntaxKind.ArrayCreationExpression:
                return BindArrayCreationExpression((ArrayCreationExpressionSyntax)syntax);
            case SyntaxKind.MapCreationExpression:
                return BindMapCreationExpression((MapCreationExpressionSyntax)syntax);
            case SyntaxKind.IndexExpression:
                return BindIndexExpression((IndexExpressionSyntax)syntax);
            case SyntaxKind.IndexAssignmentExpression:
                return BindIndexAssignmentExpression((IndexAssignmentExpressionSyntax)syntax);
            case SyntaxKind.MemberIndexAssignmentExpression:
                return BindMemberIndexAssignmentExpression((MemberIndexAssignmentExpressionSyntax)syntax);
            case SyntaxKind.CompoundIndexAssignmentExpression:
                return BindCompoundIndexAssignmentExpression((CompoundIndexAssignmentExpressionSyntax)syntax);
            case SyntaxKind.StructLiteralExpression:
                return BindStructLiteralExpression((StructLiteralExpressionSyntax)syntax);
            case SyntaxKind.TupleLiteralExpression:
                return BindTupleLiteralExpression((TupleLiteralExpressionSyntax)syntax);
            case SyntaxKind.FunctionLiteralExpression:
                return lambdas.BindFunctionLiteralExpression((FunctionLiteralExpressionSyntax)syntax);
            case SyntaxKind.AwaitExpression:
                return BindAwaitExpression((AwaitExpressionSyntax)syntax);
            case SyntaxKind.SwitchExpression:
                return BindSwitchExpression((SwitchExpressionSyntax)syntax);
            case SyntaxKind.MakeChannelExpression:
                return BindMakeChannelExpression((MakeChannelExpressionSyntax)syntax);
            case SyntaxKind.TypeOfExpression:
                return BindTypeOfExpression((TypeOfExpressionSyntax)syntax);
            case SyntaxKind.NameOfExpression:
                return BindNameOfExpression((NameOfExpressionSyntax)syntax);
            case SyntaxKind.FieldAssignmentExpression:
                return BindFieldAssignmentExpression((FieldAssignmentExpressionSyntax)syntax);
            case SyntaxKind.EventSubscriptionExpression:
                return BindEventSubscriptionExpression((EventSubscriptionExpressionSyntax)syntax);
            case SyntaxKind.WithExpression:
                return BindWithExpression((WithExpressionSyntax)syntax);
            case SyntaxKind.NamedArgumentExpression:
                Diagnostics.ReportNamedArgumentOnlyValidForCopy(syntax.Location);
                return new BoundErrorExpression(null);
            case SyntaxKind.RefArgumentExpression:
                // ADR-0060: a ref-kind argument expression is only valid at an
                // argument position; if it surfaces in any other expression
                // context it is rejected here. The call-site binder dispatches
                // to BindRefArgumentExpression directly before reaching this.
                Diagnostics.ReportOutDeclarationOutsideOutArgument(syntax.Location);
                return new BoundErrorExpression(null);
            case SyntaxKind.ConditionalRefArgumentExpression:
                // ADR-0061: a legacy conditional ref-argument expression
                // (with inner ref-kind modifiers) is only valid as the
                // payload of a ref-kind modifier or as the operand of `&`.
                // Those sites dispatch to the dedicated binders below;
                // anywhere else is a hard error.
                Diagnostics.ReportConditionalRefArgumentOutsideRefContext(syntax.Location);
                return new BoundErrorExpression(null);
            case SyntaxKind.ConditionalExpression:
                // ADR-0062: general two-arm conditional in value context.
                // In ref-kind argument payloads and as the operand of `&`,
                // the call sites short-circuit to BindConditionalAddress
                // before reaching this dispatch.
                return BindConditionalExpression((ConditionalExpressionSyntax)syntax);
            case SyntaxKind.IndirectAssignmentExpression:
                return BindIndirectAssignmentExpression((IndirectAssignmentExpressionSyntax)syntax);
            default:
                throw new Exception($"Unexpected syntax {syntax.Kind}");
        }
    }

    private BoundExpression BindParenthesizedExpression(ParenthesizedExpressionSyntax syntax)
    {
        return BindExpression(syntax.Expression);
    }

    private BoundExpression BindLiteralExpression(LiteralExpressionSyntax syntax)
    {
        // Phase 3.C.2: a literal whose syntax value is null is the `nil`
        // literal — preserve null so BoundLiteralExpression picks the Null
        // sentinel type. All other literals default missing values to 0
        // for legacy parser robustness.
        var value = syntax.Value;
        if (value == null && syntax.LiteralToken.Kind != SyntaxKind.NilKeyword)
        {
            value = 0;
        }

        return new BoundLiteralExpression(null, value);
    }

    private BoundExpression BindInterpolatedStringExpression(InterpolatedStringExpressionSyntax syntax)
    {
        // ADR-0055 (Phase 2): bind `"a $x b ${expr,align:fmt} c"` to a dedicated
        // BoundInterpolatedStringExpression carrying the ordered literal/hole
        // parts. Lowering is deferred (late) so that format/alignment intent is
        // preserved through binding — the interpreter renders the node directly,
        // and the emitter lowers it to the DefaultInterpolatedStringHandler
        // pattern (issue #368). This replaces the legacy eager `+`-chain that
        // mis-asserted `string`/`string?` operand types and produced the #366
        // memory-unsafe IL.
        var parts = ImmutableArray.CreateBuilder<BoundInterpolatedStringPart>(syntax.Segments.Length);
        foreach (var segment in syntax.Segments)
        {
            if (segment.IsExpression)
            {
                var bound = BindExpression(segment.Expression);
                if (bound is BoundErrorExpression)
                {
                    return bound;
                }

                if (bound.Type == null || bound.Type == TypeSymbol.Void)
                {
                    Diagnostics.ReportCannotConvert(segment.Expression.Location, bound.Type, TypeSymbol.String);
                    return new BoundErrorExpression(null);
                }

                parts.Add(BoundInterpolatedStringPart.FromHole(bound, segment.Alignment, segment.Format));
            }
            else
            {
                parts.Add(BoundInterpolatedStringPart.FromLiteral(segment.Text ?? string.Empty));
            }
        }

        return new BoundInterpolatedStringExpression(syntax, parts.ToImmutable());
    }

    /// <summary>
    /// ADR-0055 Tier 4: lowers an interpolated string whose contextual target
    /// type is <see cref="System.IFormattable"/> or
    /// <see cref="System.FormattableString"/> to
    /// <c>FormattableStringFactory.Create(format, object[])</c>, preserving the
    /// composite format string (alignment/format clauses included) so the caller
    /// can defer formatting and choose a culture at consumption time. The result
    /// is a <see cref="System.FormattableString"/> value, which is reference-
    /// compatible with an <see cref="System.IFormattable"/> target.
    /// </summary>
    private BoundExpression BindInterpolatedStringAsFormattable(InterpolatedStringExpressionSyntax syntax, TypeSymbol targetType)
    {
        _ = targetType;
        if (!TryBuildInterpolationFormat(syntax, out var composite, out var holeValues))
        {
            return new BoundErrorExpression(null);
        }

        var formatLiteral = new BoundLiteralExpression(null, composite);
        var argArray = BuildObjectArgumentArray(holeValues);

        var factoryType = typeof(System.Runtime.CompilerServices.FormattableStringFactory);
        var createMethod = factoryType.GetMethod("Create", new[] { typeof(string), typeof(object[]) });
        var importedClass = new ImportedClassSymbol(factoryType, declaration: null);
        var importedFn = new ImportedFunctionSymbol(createMethod.Name, importedClass, createMethod, declaration: null);
        return new BoundImportedCallExpression(null, importedFn, ImmutableArray.Create<BoundExpression>(formatLiteral, argArray));
    }

    /// <summary>
    /// Determines whether <paramref name="type"/> is the contextual target type
    /// that triggers ADR-0055 Tier 4 lowering — <c>System.IFormattable</c> or
    /// <c>System.FormattableString</c>. Compared by full name so the check is
    /// robust to metadata-load-context type identity.
    /// </summary>
    private static bool IsFormattableStringTargetType(TypeSymbol type)
    {
        var fullName = type?.ClrType?.FullName;
        return fullName == "System.FormattableString" || fullName == "System.IFormattable";
    }

    /// <summary>
    /// ADR-0055 Tier 4 (#369): builds the per-argument flags consumed by
    /// <see cref="OverloadResolution.Resolve{T}(System.Collections.Generic.IEnumerable{T}, System.Collections.Generic.IReadOnlyList{System.Type}, System.Collections.Generic.IReadOnlyList{System.Type}, System.Func{System.Type, System.Type}, System.Collections.Generic.IReadOnlyList{bool}, System.Collections.Generic.IReadOnlyList{string})"/>,
    /// marking each positional argument whose syntax is an interpolated-string
    /// literal. These arguments may convert to an
    /// <c>IFormattable</c>/<c>FormattableString</c> parameter in addition to
    /// their natural <c>string</c> type. Returns <see langword="null"/> when no
    /// argument qualifies so callers pay nothing on the common path.
    /// </summary>
    private static IReadOnlyList<bool> ComputeInterpolatedStringArgFlags(SeparatedSyntaxList<ExpressionSyntax> argumentSyntax, int count)
    {
        bool[] flags = null;
        var limit = Math.Min(count, argumentSyntax.Count);
        for (var i = 0; i < limit; i++)
        {
            if (argumentSyntax[i] is InterpolatedStringExpressionSyntax)
            {
                flags ??= new bool[count];
                flags[i] = true;
            }
        }

        return flags;
    }

    /// <summary>
    /// ADR-0055 Tier 4 (#369): after overload resolution selects an imported
    /// method/constructor, re-lowers each interpolated-string argument whose
    /// chosen parameter type is <c>IFormattable</c>/<c>FormattableString</c> to
    /// <c>FormattableStringFactory.Create(...)</c>. Arguments bound against any
    /// other parameter (including <c>string</c>) are left untouched. Returns the
    /// original array unchanged when nothing needs re-lowering.
    /// </summary>
    private ImmutableArray<BoundExpression> RebindFormattableInterpolationArguments(
        ImmutableArray<BoundExpression> arguments,
        SeparatedSyntaxList<ExpressionSyntax> argumentSyntax,
        System.Reflection.ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping = default)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        var limit = Math.Min(arguments.Length, argumentSyntax.Count);
        for (var i = 0; i < limit; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            if (paramIndex >= parameters.Length)
            {
                continue;
            }

            var argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax[i]);
            if (argSyntax is InterpolatedStringExpressionSyntax interpolated
                && OverloadResolution.IsFormattableStringTarget(parameters[paramIndex].ParameterType))
            {
                builder ??= arguments.ToBuilder();
                builder[i] = BindInterpolatedStringAsFormattable(interpolated, targetType: null);
            }
        }

        return builder?.ToImmutable() ?? arguments;
    }

    /// <summary>
    /// Builds the C#-style composite format string (<c>"{0}"</c>,
    /// <c>"{0,10}"</c>, <c>"{0,-20:N2}"</c>) and the ordered, bound hole values
    /// for an interpolated string. Literal braces are escaped (<c>{</c> →
    /// <c>{{</c>) so they survive <c>String.Format</c>/<c>FormattableString</c>
    /// formatting. Returns <c>false</c> if any hole fails to bind.
    /// </summary>
    private bool TryBuildInterpolationFormat(InterpolatedStringExpressionSyntax syntax, out string composite, out ImmutableArray<BoundExpression> holeValues)
    {
        composite = null;
        holeValues = default;

        var format = new StringBuilder();
        var values = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var segment in syntax.Segments)
        {
            if (!segment.IsExpression)
            {
                AppendEscapedLiteral(format, segment.Text ?? string.Empty);
                continue;
            }

            var bound = BindExpression(segment.Expression);
            if (bound is BoundErrorExpression)
            {
                return false;
            }

            var index = values.Count;
            values.Add(bound);

            format.Append('{').Append(index.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (segment.Alignment.HasValue)
            {
                format.Append(',').Append(segment.Alignment.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }

            if (segment.Format != null)
            {
                format.Append(':').Append(segment.Format);
            }

            format.Append('}');
        }

        composite = format.ToString();
        holeValues = values.ToImmutable();
        return true;
    }

    private static void AppendEscapedLiteral(StringBuilder builder, string text)
    {
        foreach (var c in text)
        {
            if (c == '{' || c == '}')
            {
                builder.Append(c);
            }

            builder.Append(c);
        }
    }

    /// <summary>
    /// Wraps the bound hole values in an <c>object[]</c> creation, boxing value
    /// types via an explicit conversion to <c>object</c> so the emitter produces
    /// verifiable IL (ADR-0055 — no <c>Convert.ToString</c> mis-typing).
    /// </summary>
    private BoundExpression BuildObjectArgumentArray(ImmutableArray<BoundExpression> holeValues)
    {
        var elements = ImmutableArray.CreateBuilder<BoundExpression>(holeValues.Length);
        foreach (var value in holeValues)
        {
            elements.Add(value.Type == TypeSymbol.Object
                ? value
                : new BoundConversionExpression(null, TypeSymbol.Object, value));
        }

        var arrayType = ArrayTypeSymbol.Get(TypeSymbol.Object, holeValues.Length);
        return new BoundArrayCreationExpression(null, arrayType, elements.ToImmutable());
    }

    private BoundExpression BuildStringFormatCall(string composite, ImmutableArray<BoundExpression> holeValues)
    {
        var formatLiteral = new BoundLiteralExpression(null, composite);
        var argArray = BuildObjectArgumentArray(holeValues);

        var stringType = typeof(string);
        var formatMethod = stringType.GetMethod("Format", new[] { typeof(string), typeof(object[]) });
        var importedClass = new ImportedClassSymbol(stringType, declaration: null);
        var importedFn = new ImportedFunctionSymbol(formatMethod.Name, importedClass, formatMethod, declaration: null);
        return new BoundImportedCallExpression(null, importedFn, ImmutableArray.Create<BoundExpression>(formatLiteral, argArray));
    }

    private BoundExpression ConvertToString(BoundExpression expression, TextLocation diagnosticLocation)
    {
        if (expression.Type == TypeSymbol.String)
        {
            return expression;
        }

        var clrType = expression.Type?.ClrType;
        if (clrType == null)
        {
            Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, TypeSymbol.String);
            return new BoundErrorExpression(null);
        }

        // Bind a call to `System.Convert.ToString(<expr.Type>)`. Convert.ToString
        // is a static overload set covering every primitive (int, long, bool,
        // double, ...) plus `object`, so it works uniformly without emitter
        // changes for value-type instance dispatch.
        var convertType = typeof(System.Convert);
        var method = convertType.GetMethod("ToString", new[] { clrType })
            ?? convertType.GetMethod("ToString", new[] { typeof(object) });
        if (method == null)
        {
            Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, TypeSymbol.String);
            return new BoundErrorExpression(null);
        }

        var importedClass = new ImportedClassSymbol(convertType, declaration: null);
        var importedFn = new ImportedFunctionSymbol(method.Name, importedClass, method, declaration: null);
        return new BoundImportedCallExpression(null, importedFn, ImmutableArray.Create(expression));
    }

    private static BoundExpression Concat(BoundExpression left, BoundExpression right)
    {
        var op = BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.String, TypeSymbol.String);
        return new BoundBinaryExpression(null, left, op, right);
    }

    private BoundExpression BindNameExpression(NameExpressionSyntax syntax)
    {
        var name = syntax.IdentifierToken.Text;
        if (syntax.IdentifierToken.IsMissing)
        {
            // This means the token was inserted by the parser. We already
            // reported error so we can just return an error expression.
            return new BoundErrorExpression(null);
        }

        var variable = BindVariableReference(name, syntax.IdentifierToken.Location, suppressNotAVariable: true);
        if (variable == null)
        {
            // Issue #324: a bare identifier naming a free (package-level)
            // function is a method group. In a value context — e.g. assigning
            // to a `func(...)` or `Func[...]` slot — it converts to a delegate
            // over that function. We only synthesize the group here; the
            // conversion classifier decides whether the surrounding context
            // actually accepts it (otherwise a cannot-convert is reported).
            if (TryBindMethodGroup(name, out var methodGroup))
            {
                return methodGroup;
            }

            // Not a method group: surface the suppressed GS0126 (or the
            // undefined-variable diagnostic already reported).
            if (scope.TryLookupSymbol(name) is not null and not VariableSymbol)
            {
                Diagnostics.ReportNotAVariable(syntax.IdentifierToken.Location, name);
            }

            return new BoundErrorExpression(null);
        }

        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            // Issue #186 / #175: bare field-name read inside a method fires
            // GS0204 if the underlying field carries `@Obsolete`.
            ReportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitField.Field,
                $"{implicitField.StructType.Name}.{implicitField.Field.Name}");

            // Issue #208: apply any [MemberNotNull] post-call narrowing so that
            // `field.Member` accesses after a [MemberNotNull] helper call are
            // accepted without a nil-guard.
            var narrowedFieldType = TryGetNarrowedType(implicitField);
            return new BoundFieldAccessExpression(
                null,
                new BoundVariableExpression(null, implicitField.Receiver),
                implicitField.StructType,
                implicitField.Field,
                narrowedFieldType);
        }

        // Issue #261: bare static field name inside a shared method body.
        if (variable is ImplicitStaticFieldVariableSymbol implicitStaticField)
        {
            ReportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticField.Field,
                $"{implicitStaticField.StructType.Name}.{implicitStaticField.Field.Name}");

            return new BoundFieldAccessExpression(
                null,
                receiver: null,
                implicitStaticField.StructType,
                implicitStaticField.Field);
        }

        // ADR-0053: bare static property name inside a method body (shared
        // or instance) of the enclosing type.
        if (variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp)
        {
            ReportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticProp.Property,
                $"{implicitStaticProp.StructType.Name}.{implicitStaticProp.Property.Name}");

            if (!implicitStaticProp.Property.HasGetter)
            {
                Diagnostics.ReportCannotAssign(syntax.IdentifierToken.Location, implicitStaticProp.Property.Name);
                return new BoundErrorExpression(null);
            }

            return new BoundPropertyAccessExpression(
                null,
                receiver: null,
                implicitStaticProp.StructType,
                implicitStaticProp.Property);
        }

        // Bare property name inside an instance method body resolves to
        // `this.<property>` (analogous to implicit field access).
        if (variable is ImplicitPropertyVariableSymbol implicitProp)
        {
            ReportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitProp.Property,
                $"{implicitProp.StructType.Name}.{implicitProp.Property.Name}");

            if (!implicitProp.Property.HasGetter)
            {
                Diagnostics.ReportCannotAssign(syntax.IdentifierToken.Location, implicitProp.Property.Name);
                return new BoundErrorExpression(null);
            }

            return new BoundPropertyAccessExpression(
                null,
                new BoundVariableExpression(null, implicitProp.Receiver),
                implicitProp.StructType,
                implicitProp.Property);
        }

        return new BoundVariableExpression(null, variable, TryGetNarrowedType(variable));
    }

    private TypeSymbol TryGetNarrowedType(VariableSymbol variable)
    {
        // Phase 3.C.4: smart-cast narrowing map. Walk the active stack from
        // innermost frame outward — the topmost narrowing wins.
        for (var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i--)
        {
            if (binderCtx.NarrowedVariables[i].TryGetValue(variable, out var narrowed))
            {
                return narrowed;
            }
        }

        return null;
    }

    private BoundExpression BindAssignmentExpression(AssignmentExpressionSyntax syntax)
    {
        var name = syntax.IdentifierToken.Text;
        var boundExpression = BindExpression(syntax.Expression);

        var variable = BindVariableReference(name, syntax.IdentifierToken.Location);
        if (variable == null)
        {
            return boundExpression;
        }

        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            if (implicitField.Field.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }

            // Issue #186 / #175: bare field-name write inside a method fires
            // GS0204 if the underlying field carries `@Obsolete`.
            ReportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitField.Field,
                $"{implicitField.StructType.Name}.{implicitField.Field.Name}");

            var convertedValue = conversions.BindConversion(syntax.Expression.Location, boundExpression, implicitField.Field.Type);
            return new BoundFieldAssignmentExpression(null, implicitField.Receiver, implicitField.StructType, implicitField.Field, convertedValue);
        }

        // Issue #261: bare static field assignment inside a shared method body.
        if (variable is ImplicitStaticFieldVariableSymbol implicitStaticField)
        {
            if (implicitStaticField.Field.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }

            ReportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticField.Field,
                $"{implicitStaticField.StructType.Name}.{implicitStaticField.Field.Name}");

            var convertedValue = conversions.BindConversion(syntax.Expression.Location, boundExpression, implicitStaticField.Field.Type);
            return new BoundFieldAssignmentExpression(null, null, implicitStaticField.StructType, implicitStaticField.Field, convertedValue);
        }

        // ADR-0053: bare static property assignment inside a method body
        // (shared or instance) of the enclosing type.
        if (variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp)
        {
            if (!implicitStaticProp.Property.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }

            ReportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitStaticProp.Property,
                $"{implicitStaticProp.StructType.Name}.{implicitStaticProp.Property.Name}");

            var convertedValue = conversions.BindConversion(syntax.Expression.Location, boundExpression, implicitStaticProp.Property.Type);
            return new BoundPropertyAssignmentExpression(
                null,
                receiver: null,
                implicitStaticProp.StructType,
                implicitStaticProp.Property,
                convertedValue);
        }

        // Bare property name assignment inside an instance method body resolves
        // to `this.<property> = value` (analogous to implicit field assignment).
        if (variable is ImplicitPropertyVariableSymbol implicitProp)
        {
            if (!implicitProp.Property.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }

            ReportObsoleteUseIfApplicable(
                syntax.IdentifierToken.Location,
                implicitProp.Property,
                $"{implicitProp.StructType.Name}.{implicitProp.Property.Name}");

            var convertedValue = conversions.BindConversion(syntax.Expression.Location, boundExpression, implicitProp.Property.Type);
            return new BoundPropertyAssignmentExpression(
                null,
                new BoundVariableExpression(null, implicitProp.Receiver),
                implicitProp.StructType,
                implicitProp.Property,
                convertedValue);
        }

        if (variable.IsReadOnly)
        {
            // ADR-0060: an `in` parameter is read-only because of its ref-kind,
            // not because of the standard `let` quality. Report GS0237 with
            // ADR-specific wording instead of the generic "cannot assign to const".
            if (variable is ParameterSymbol inParam && inParam.RefKind == RefKind.In)
            {
                Diagnostics.ReportCannotAssignToInParameter(syntax.EqualsToken.Location, name);
            }
            else
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
            }
        }

        var convertedExpression = conversions.BindConversion(syntax.Expression.Location, boundExpression, variable.Type);

        return new BoundAssignmentExpression(null, variable, convertedExpression);
    }

    private BoundExpression BindWithExpression(WithExpressionSyntax syntax)
    {
        var receiver = BindExpression(syntax.Receiver);
        return LowerCopyOrWith(receiver, syntax.Initializers, syntax.WithToken.Location);
    }

    private BoundExpression LowerCopyOrWith(BoundExpression receiver, SeparatedSyntaxList<FieldInitializerSyntax> overrides, TextLocation diagnosticLocation)
    {
        if (receiver.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        if (!(receiver.Type is StructSymbol structType) || !structType.IsData)
        {
            Diagnostics.ReportCopyOrWithNotDataStruct(diagnosticLocation, receiver.Type);
            return new BoundErrorExpression(null);
        }

        var tempName = "$copy" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, structType);
        scope.TryDeclareVariable(tempVar);

        var seen = new HashSet<string>();
        var explicitValues = new Dictionary<string, (FieldSymbol Field, StructSymbol DeclaringType, BoundExpression Value)>();
        foreach (var initSyntax in overrides)
        {
            var fieldName = initSyntax.FieldIdentifier.Text;
            if (!seen.Add(fieldName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            if (!structType.TryGetFieldIncludingInherited(fieldName, out var field, out var declaringType))
            {
                Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            var valueExpr = BindExpression(initSyntax.Value);
            valueExpr = conversions.BindConversion(initSyntax.Value.Location, valueExpr, field.Type);
            explicitValues[fieldName] = (field, declaringType, valueExpr);
        }

        var initializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>();
        foreach (var field in structType.Fields)
        {
            if (explicitValues.TryGetValue(field.Name, out var explicitValue))
            {
                initializers.Add(new BoundFieldInitializer(explicitValue.Field, explicitValue.Value));
            }
            else
            {
                var access = new BoundFieldAccessExpression(null, new BoundVariableExpression(null, tempVar), structType, field);
                initializers.Add(new BoundFieldInitializer(field, access));
            }
        }

        var declaration = new BoundVariableDeclaration(null, tempVar, receiver);
        var literal = new BoundStructLiteralExpression(null, structType, initializers.ToImmutable());
        return new BoundBlockExpression(null, ImmutableArray.Create<BoundStatement>(declaration), literal);
    }

    // Issue #522: bind `T(args) { Prop1 = v1, Prop2 = v2, … }` object
    // initializer. The construction is lowered to a synthetic local plus a
    // sequence of property assignments:
    //   { var $tmp = T(args); $tmp.Prop1 = v1; $tmp.Prop2 = v2; $tmp }
    // Init-only setters are emitted via the regular setter call path; the
    // emit-side modreq fix (EncodeReturnClr) makes the resulting IL valid.
    private BoundExpression BindObjectCreationExpression(ObjectCreationExpressionSyntax syntax)
    {
        var target = BindExpression(syntax.Target);
        if (target.Type == TypeSymbol.Error || target.Type == null)
        {
            // Still drain the initializer values so they report their own
            // diagnostics (e.g. unresolved names inside the RHS expressions).
            foreach (var init in syntax.Initializers)
            {
                _ = BindExpression(init.Value);
            }

            return new BoundErrorExpression(null);
        }

        var resultType = target.Type;

        var tempName = "$objinit" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, resultType);
        scope.TryDeclareVariable(tempVar);

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(syntax, tempVar, target));

        var seen = new HashSet<string>();
        foreach (var initSyntax in syntax.Initializers)
        {
            var propertyName = initSyntax.PropertyIdentifier.Text;
            if (!seen.Add(propertyName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.PropertyIdentifier.Location, propertyName);
                continue;
            }

            var assignment = BindObjectInitializerAssignment(tempVar, resultType, initSyntax);
            if (assignment == null)
            {
                continue;
            }

            statements.Add(new BoundExpressionStatement(initSyntax, assignment));
        }

        var resultExpr = new BoundVariableExpression(syntax, tempVar);
        return new BoundBlockExpression(syntax, statements.ToImmutable(), resultExpr);
    }

    // Issue #522: bind a single `Prop = value` initializer against a known
    // receiver local. Mirrors the property/field write logic in
    // BindFieldAssignmentExpression so init-only setters, regular setters,
    // user-defined struct properties, and CLR-base inherited members all
    // route through the same lowering.
    private BoundExpression BindObjectInitializerAssignment(LocalVariableSymbol receiverLocal, TypeSymbol receiverType, PropertyInitializerSyntax initSyntax)
    {
        var propertyName = initSyntax.PropertyIdentifier.Text;

        // Receiver-side type discriminator mirrors the receiver dispatch in
        // BindFieldAssignmentExpression: pure CLR types go through reflection;
        // user-defined StructSymbols use the symbol tables; both can fall
        // through to ImportedBaseType lookup for inherited CLR members.
        if (receiverType is not StructSymbol && receiverType is not NullableTypeSymbol && receiverType.ClrType != null)
        {
            var clrReceiverType = receiverType.ClrType;
            MemberInfo instanceMember = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(clrReceiverType, propertyName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember is PropertyInfo idxProp && idxProp.GetIndexParameters().Length != 0)
            {
                instanceMember = null;
            }

            instanceMember ??= ClrTypeUtilities.SafeGetFieldIncludingInterfaces(clrReceiverType, propertyName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember == null)
            {
                Diagnostics.ReportUnableToFindMember(initSyntax.PropertyIdentifier.Location, propertyName);
                _ = BindExpression(initSyntax.Value);
                return null;
            }

            if (!TryGetWritableClrMember(instanceMember, out _, out var instTargetSymbol, out _))
            {
                Diagnostics.ReportCannotAssign(initSyntax.EqualsToken.Location, propertyName);
                _ = BindExpression(initSyntax.Value);
                return null;
            }

            var value = BindExpression(initSyntax.Value);
            var converted = conversions.BindConversion(initSyntax.Value.Location, value, instTargetSymbol);
            var receiverExpr = new BoundVariableExpression(initSyntax, receiverLocal);
            return new BoundClrPropertyAssignmentExpression(initSyntax, receiverExpr, instanceMember, converted, instTargetSymbol);
        }

        if (receiverType is StructSymbol structSymbol)
        {
            if (structSymbol.TryGetFieldIncludingInherited(propertyName, out var field, out _))
            {
                var value = BindExpression(initSyntax.Value);
                var converted = conversions.BindConversion(initSyntax.Value.Location, value, field.Type);
                return new BoundFieldAssignmentExpression(initSyntax, receiverLocal, structSymbol, field, converted);
            }

            if (MemberLookup.TryGetPropertyIncludingInherited(structSymbol, propertyName, out var prop))
            {
                if (!prop.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(initSyntax.EqualsToken.Location, propertyName);
                    _ = BindExpression(initSyntax.Value);
                    return null;
                }

                var value = BindExpression(initSyntax.Value);
                var converted = conversions.BindConversion(initSyntax.Value.Location, value, prop.Type);
                var receiverExpr = new BoundVariableExpression(initSyntax, receiverLocal);
                return new BoundPropertyAssignmentExpression(initSyntax, receiverExpr, structSymbol, prop, converted);
            }

            // Issue #319 parity: fall through to imported base CLR members.
            if (structSymbol.ImportedBaseType?.ClrType is Type inheritedBaseClr)
            {
                MemberInfo inhMember = ClrTypeUtilities.SafeGetProperty(inheritedBaseClr, propertyName, BindingFlags.Public | BindingFlags.Instance);
                if (inhMember is PropertyInfo inhIdxProp && inhIdxProp.GetIndexParameters().Length != 0)
                {
                    inhMember = null;
                }

                inhMember ??= ClrTypeUtilities.SafeGetField(inheritedBaseClr, propertyName, BindingFlags.Public | BindingFlags.Instance);
                if (inhMember != null)
                {
                    if (!TryGetWritableClrMember(inhMember, out _, out var inhTargetSymbol, out _))
                    {
                        Diagnostics.ReportCannotAssign(initSyntax.EqualsToken.Location, propertyName);
                        _ = BindExpression(initSyntax.Value);
                        return null;
                    }

                    var value = BindExpression(initSyntax.Value);
                    var converted = conversions.BindConversion(initSyntax.Value.Location, value, inhTargetSymbol);
                    var receiverExpr = new BoundVariableExpression(initSyntax, receiverLocal);
                    return new BoundClrPropertyAssignmentExpression(initSyntax, receiverExpr, inhMember, converted, inhTargetSymbol);
                }
            }

            Diagnostics.ReportUnableToFindMember(initSyntax.PropertyIdentifier.Location, propertyName);
            _ = BindExpression(initSyntax.Value);
            return null;
        }

        Diagnostics.ReportUnableToFindMember(initSyntax.PropertyIdentifier.Location, propertyName);
        _ = BindExpression(initSyntax.Value);
        return null;
    }

    private static bool TryGetCopyOverrides(CallExpressionSyntax call, out SeparatedSyntaxList<FieldInitializerSyntax> overrides)
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        foreach (var node in call.Arguments.GetWithSeparators())
        {
            if (node is SyntaxToken token)
            {
                nodesAndSeparators.Add(token);
                continue;
            }

            if (node is NamedArgumentExpressionSyntax named)
            {
                nodesAndSeparators.Add(new FieldInitializerSyntax(named.SyntaxTree, named.NameToken, named.EqualsToken, named.Expression));
                continue;
            }

            overrides = default;
            return false;
        }

        overrides = new SeparatedSyntaxList<FieldInitializerSyntax>(nodesAndSeparators.ToImmutable());
        return true;
    }

    private BoundExpression BindStructLiteralExpression(StructLiteralExpressionSyntax syntax)
    {
        var typeName = syntax.TypeIdentifier.Text;
        if (!scope.TryLookupTypeAlias(typeName, out var resolvedType) || !(resolvedType is StructSymbol structSymbol))
        {
            Diagnostics.ReportUnableToFindType(syntax.TypeIdentifier.Location, typeName);
            return new BoundErrorExpression(null);
        }

        // ADR-0047 §6 / #175: struct/class literal `Foo{ ... }` is a
        // use of the named type.
        ReportObsoleteUseIfApplicable(syntax.TypeIdentifier.Location, structSymbol, structSymbol.Name);

        // Phase 4.3 / ADR-0020: if the declared struct is generic, build a
        // type-argument substitution (explicit or inferred from initializers)
        // and construct a closed StructSymbol to bind against. Constructed
        // instances are cached so reference-equality of TypeSymbols is
        // preserved (e.g. `Result[int, string]` always returns the same
        // StructSymbol object).
        if (structSymbol.IsGenericDefinition)
        {
            Dictionary<TypeParameterSymbol, TypeSymbol> substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            var tps = structSymbol.TypeParameters;

            if (syntax.TypeArgumentList != null)
            {
                var explicitArgs = syntax.TypeArgumentList.Arguments;
                if (explicitArgs.Count != tps.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, typeName, tps.Length, explicitArgs.Count);
                    return new BoundErrorExpression(null);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = BindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    substitution[tps[i]] = ta;
                }
            }
            else
            {
                // Infer from the initializer expression types matched against
                // the corresponding field's declared type (first-seen wins,
                // consistent with Phase 4.1 call-site inference).
                foreach (var initSyntax in syntax.Initializers)
                {
                    if (!structSymbol.TryGetFieldIncludingInherited(initSyntax.FieldIdentifier.Text, out var field, out _))
                    {
                        continue;
                    }

                    var valueExpr = BindExpression(initSyntax.Value);
                    InferTypeArguments(field.Type, valueExpr.Type, substitution);
                }

                foreach (var tp in tps)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(syntax.TypeIdentifier.Location, typeName, tp.Name);
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // Phase 4.2 constraint satisfaction.
            var constraintLocation = syntax.TypeArgumentList != null
                ? syntax.TypeArgumentList.Location
                : syntax.TypeIdentifier.Location;
            foreach (var tp in tps)
            {
                var typeArg = substitution[tp];
                if (!SatisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, DescribeConstraint(tp));
                    return new BoundErrorExpression(null);
                }
            }

            var typeArgs = ImmutableArray.CreateBuilder<TypeSymbol>(tps.Length);
            foreach (var tp in tps)
            {
                typeArgs.Add(substitution[tp]);
            }

            structSymbol = StructSymbol.Construct(structSymbol, typeArgs.MoveToImmutable());
        }
        else if (syntax.TypeArgumentList != null)
        {
            Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, typeName, 0, syntax.TypeArgumentList.Arguments.Count);
            return new BoundErrorExpression(null);
        }

        var seenFieldNames = new HashSet<string>();
        var inits = ImmutableArray.CreateBuilder<BoundFieldInitializer>();
        foreach (var initSyntax in syntax.Initializers)
        {
            var fieldName = initSyntax.FieldIdentifier.Text;
            if (!structSymbol.TryGetFieldIncludingInherited(fieldName, out var field, out _))
            {
                Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            if (!seenFieldNames.Add(fieldName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            var valueExpr = BindExpression(initSyntax.Value);
            valueExpr = conversions.BindConversion(initSyntax.Value.Location, valueExpr, field.Type);
            inits.Add(new BoundFieldInitializer(field, valueExpr));
        }

        return new BoundStructLiteralExpression(null, structSymbol, inits.ToImmutable());
    }

    private BoundExpression BindTupleLiteralExpression(TupleLiteralExpressionSyntax syntax)
    {
        // Phase 4.5: bind each element expression, derive the tuple type from
        // their static types, and produce a BoundTupleLiteralExpression.
        var bound = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Elements.Count);
        var elementTypes = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.Elements.Count);
        foreach (var e in syntax.Elements)
        {
            var be = BindExpression(e);
            if (be.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            bound.Add(be);
            elementTypes.Add(be.Type);
        }

        var tupleType = TupleTypeSymbol.Get(elementTypes.MoveToImmutable());
        return new BoundTupleLiteralExpression(null, tupleType, bound.MoveToImmutable());
    }

    private BoundExpression BindFieldAssignmentExpression(FieldAssignmentExpressionSyntax syntax)
    {
        var receiverName = syntax.Receiver.Text;

        // Stream B: imported class name on LHS → static field/property write.
        // Probe the import table FIRST so we don't shadow with a variable lookup
        // diagnostic.
        if (scope.TryLookupImportedClass(receiverName, declaration: null, out var importedClass))
        {
            var staticValue = BindExpression(syntax.Value);
            if (!importedClass.TryLookupMember(syntax.FieldIdentifier.Text, ne: null, out var staticMember))
            {
                Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.Text);
                return new BoundErrorExpression(null);
            }

            if (!TryGetWritableClrMember(staticMember, out var staticTargetType, out var staticTargetSymbol, out var staticWritable))
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.Text);
                return new BoundErrorExpression(null);
            }

            _ = staticWritable;
            _ = staticTargetType;
            var staticConverted = conversions.BindConversion(syntax.Value.Location, staticValue, staticTargetSymbol);
            return new BoundClrPropertyAssignmentExpression(null, receiver: null, staticMember, staticConverted, staticTargetSymbol);
        }

        // ADR-0053: user-defined struct/class type → static field write.
        if (scope.TryLookupTypeAlias(receiverName, out var typeAlias) && typeAlias is StructSymbol userStruct)
        {
            var staticValue = BindExpression(syntax.Value);
            var fieldName = syntax.FieldIdentifier.Text;
            if (userStruct.TryGetStaticField(fieldName, out var staticField))
            {
                if (staticField.IsReadOnly)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                }

                var staticConverted = conversions.BindConversion(syntax.Value.Location, staticValue, staticField.Type);
                return new BoundFieldAssignmentExpression(null, null, userStruct, staticField, staticConverted);
            }

            // Issue #263: static property assignment.
            foreach (var prop in userStruct.StaticProperties)
            {
                if (prop.Name == fieldName)
                {
                    if (!prop.HasSetter)
                    {
                        Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                        return new BoundErrorExpression(null);
                    }

                    var propConverted = conversions.BindConversion(syntax.Value.Location, staticValue, prop.Type);
                    return new BoundPropertyAssignmentExpression(null, receiver: null, userStruct, prop, propConverted);
                }
            }

            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName);
            return new BoundErrorExpression(null);
        }

        var variable = BindVariableReference(receiverName, syntax.Receiver.Location);
        var value = BindExpression(syntax.Value);
        if (variable == null)
        {
            return value;
        }

        // Stream B: instance-CLR receiver → property/field write via reflection.
        if (variable.Type is not StructSymbol && variable.Type is not NullableTypeSymbol && variable.Type?.ClrType != null)
        {
            var clrReceiverType = variable.Type.ClrType;
            var fieldName = syntax.FieldIdentifier.Text;
            MemberInfo instanceMember = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(clrReceiverType, fieldName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember is PropertyInfo prop && prop.GetIndexParameters().Length != 0)
            {
                instanceMember = null;
            }

            instanceMember ??= ClrTypeUtilities.SafeGetFieldIncludingInterfaces(clrReceiverType, fieldName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember == null)
            {
                Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName);
                return new BoundErrorExpression(null);
            }

            if (!TryGetWritableClrMember(instanceMember, out var instTargetType, out var instTargetSymbol, out var instWritable))
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                return new BoundErrorExpression(null);
            }

            _ = instWritable;
            _ = instTargetType;
            var instReceiver = new BoundVariableExpression(null, variable);
            var instConverted = conversions.BindConversion(syntax.Value.Location, value, instTargetSymbol);
            return new BoundClrPropertyAssignmentExpression(null, instReceiver, instanceMember, instConverted, instTargetSymbol);
        }

        if (!(variable.Type is StructSymbol structSymbol))
        {
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        if (!structSymbol.TryGetFieldIncludingInherited(syntax.FieldIdentifier.Text, out var field, out _))
        {
            // ADR-0051: check if it's a property.
            if (MemberLookup.TryGetPropertyIncludingInherited(structSymbol, syntax.FieldIdentifier.Text, out var prop))
            {
                if (!prop.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.Text);
                    return new BoundErrorExpression(null);
                }

                var propConverted = conversions.BindConversion(syntax.Value.Location, value, prop.Type);
                return new BoundPropertyAssignmentExpression(null, new BoundVariableExpression(null, variable), structSymbol, prop, propConverted);
            }

            // Issue #319: a GSharp class inheriting an imported CLR base exposes
            // the base's settable instance properties/fields. Fall back to CLR
            // member lookup on the imported base type so `e.HResult = 42` style
            // writes work the same as the read fallback further down.
            if (structSymbol.ImportedBaseType?.ClrType is System.Type inheritedBaseClr)
            {
                var memberName = syntax.FieldIdentifier.Text;
                MemberInfo clrMember = ClrTypeUtilities.SafeGetProperty(inheritedBaseClr, memberName, BindingFlags.Public | BindingFlags.Instance);
                if (clrMember is PropertyInfo idxProp && idxProp.GetIndexParameters().Length != 0)
                {
                    clrMember = null;
                }

                clrMember ??= ClrTypeUtilities.SafeGetField(inheritedBaseClr, memberName, BindingFlags.Public | BindingFlags.Instance);
                if (clrMember != null)
                {
                    if (!TryGetWritableClrMember(clrMember, out var inhTargetType, out var inhTargetSymbol, out var inhWritable))
                    {
                        Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, memberName);
                        return new BoundErrorExpression(null);
                    }

                    _ = inhWritable;
                    _ = inhTargetType;
                    var inhReceiver = new BoundVariableExpression(null, variable);
                    var inhConverted = conversions.BindConversion(syntax.Value.Location, value, inhTargetSymbol);
                    return new BoundClrPropertyAssignmentExpression(null, inhReceiver, clrMember, inhConverted, inhTargetSymbol);
                }
            }

            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        if (variable.IsReadOnly)
        {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, receiverName);
        }

        if (field.IsReadOnly)
        {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.Text);
        }

        // Issue #186 / #175: dotted field write fires GS0204 if the field
        // carries `@Obsolete`.
        ReportObsoleteUseIfApplicable(
            syntax.FieldIdentifier.Location,
            field,
            $"{structSymbol.Name}.{field.Name}");

        var converted = conversions.BindConversion(syntax.Value.Location, value, field.Type);
        return new BoundFieldAssignmentExpression(null, variable, structSymbol, field, converted);
    }

    private BoundExpression BindEventSubscriptionExpression(EventSubscriptionExpressionSyntax syntax)
    {
        // Bare identifier `EventName += handler` / `EventName -= handler`:
        // the parser now emits this form for all `id +=/-=` patterns. Try to
        // resolve as an event on the implicit `this`; if not an event, fall
        // back to compound assignment semantics (`x += 1`).
        if (syntax.LeftHandSide is NameExpressionSyntax bareName)
        {
            return BindBareEventOrCompoundAssignment(bareName, syntax);
        }

        // Stream B′: `lhs.Event += handler` / `lhs.Event -= handler`.
        if (syntax.LeftHandSide is not AccessorExpressionSyntax accessor)
        {
            Diagnostics.ReportUnableToFindMember(syntax.LeftHandSide.Location, syntax.OperatorToken.Text);
            return new BoundErrorExpression(null);
        }

        // Issue #503 follow-up: `A.B.Event += handler` (chained-receiver
        // subscription). The parser produces a *right-associative* accessor
        // chain — `A . (B . Event)` — so accessor.RightPart is itself an
        // AccessorExpressionSyntax and the event name is at the rightmost
        // leaf. Rotate the chain into the canonical left-associative form
        // `(A . B) . Event` so the existing receiver/event-name resolution
        // below (which assumes the right part is a single name) just works.
        accessor = NormalizeAccessorLeftAssociative(accessor);

        if (accessor.RightPart is not NameExpressionSyntax eventNameSyntax)
        {
            Diagnostics.ReportUnableToFindMember(accessor.RightPart.Location, syntax.OperatorToken.Text);
            return new BoundErrorExpression(null);
        }

        var eventName = eventNameSyntax.IdentifierToken.Text;
        var isAdd = syntax.OperatorToken.Kind == SyntaxKind.PlusEqualsToken;

        // Resolve receiver: either an ImportedClassSymbol (static event) or
        // any value-producing expression with a CLR-backed type (instance event).
        BoundExpression boundReceiver = null;
        Type receiverClrType = null;
        BindingFlags flags;
        if (accessor.LeftPart is NameExpressionSyntax leftName
            && scope.TryLookupImportedClass(leftName.IdentifierToken.Text, leftName, out var importedClass))
        {
            receiverClrType = importedClass.ClassType;
            flags = BindingFlags.Public | BindingFlags.Static;
        }
        else if (accessor.LeftPart is NameExpressionSyntax staticLeftName
            && scope.TryLookupTypeAlias(staticLeftName.IdentifierToken.Text, out var staticTypeAlias)
            && staticTypeAlias is StructSymbol staticStruct)
        {
            // Issue #263: static event subscription on a user-defined type.
            // Try matching an event first; if no match, fall through to
            // ADR-0053 static field/property compound assignment instead of
            // reporting an immediate "unable to find member".
            EventSymbol ev = null;
            if (!staticStruct.StaticEvents.IsDefaultOrEmpty)
            {
                ev = staticStruct.StaticEvents.FirstOrDefault(e => e.Name == eventName);
            }

            if (ev != null)
            {
                var userHandler = BindEventSubscriptionHandler(syntax.Value, ev.Type);
                return new BoundEventSubscriptionExpression(null, receiver: null, staticStruct, ev, userHandler, isAdd);
            }

            // ADR-0053: `Type.StaticField += rhs` / `Type.StaticProp += rhs`.
            // The simple-assignment path is handled by BindFieldAssignmentExpression
            // (lines ~6586–6619); this is the compound counterpart.
            if (TryBindUserTypeStaticCompoundAssignment(staticStruct, eventNameSyntax, syntax, isAdd, out var compoundResult))
            {
                return compoundResult;
            }

            Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName);
            return new BoundErrorExpression(null);
        }
        else
        {
            boundReceiver = BindExpression(accessor.LeftPart);
            if (boundReceiver.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            // Check for user-defined event on a StructSymbol before falling through to CLR reflection.
            if (boundReceiver.Type is StructSymbol userStruct && !userStruct.Events.IsDefaultOrEmpty)
            {
                var ev = userStruct.Events.FirstOrDefault(e => e.Name == eventName);
                if (ev != null)
                {
                    var userHandler = BindEventSubscriptionHandler(syntax.Value, ev.Type);
                    return new BoundEventSubscriptionExpression(null, boundReceiver, userStruct, ev, userHandler, isAdd);
                }
            }

            receiverClrType = boundReceiver.Type?.ClrType;
            if (receiverClrType == null)
            {
                Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName);
                return new BoundErrorExpression(null);
            }

            flags = BindingFlags.Public | BindingFlags.Instance;
        }

        var eventInfo = ClrTypeUtilities.SafeGetEvent(receiverClrType, eventName, flags);
        if (eventInfo == null)
        {
            Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName);
            return new BoundErrorExpression(null);
        }

        var handlerType = eventInfo.EventHandlerType;
        var handlerTypeSymbol = TypeSymbol.FromClrType(handlerType);
        var boundHandler = BindEventSubscriptionHandler(syntax.Value, handlerTypeSymbol);

        // The handler is most useful when expressed as a function literal of
        // matching signature. For that path we skip BindConversion (which has
        // no generic fn → custom-delegate rule) and rely on the evaluator /
        // emitter to materialize the right delegate type. Otherwise fall back
        // to the standard conversion (covers null, already-typed delegate
        // variables, etc.). Method-group handlers were already routed through
        // BindEventSubscriptionHandler above and arrive here resolved.
        BoundExpression convertedHandler;
        if (boundHandler is BoundFunctionLiteralExpression
            || boundHandler is BoundMethodGroupExpression
            || boundHandler is BoundClrMethodGroupExpression
            || (boundHandler.Type is FunctionTypeSymbol fn
                && IsSignatureCompatibleWithDelegate(fn, handlerType)))
        {
            convertedHandler = boundHandler;
        }
        else
        {
            convertedHandler = conversions.BindConversion(syntax.Value.Location, boundHandler, handlerTypeSymbol);
        }

        return new BoundClrEventSubscriptionExpression(null, boundReceiver, eventInfo, convertedHandler, isAdd);
    }

    /// <summary>
    /// Handles a bare `identifier += expr` / `identifier -= expr` that the parser
    /// emitted as an <see cref="EventSubscriptionExpressionSyntax"/> with a
    /// <see cref="NameExpressionSyntax"/> LHS. Resolves as:
    /// 1. An event subscription on the implicit <c>this</c> if the name matches an event.
    /// 2. A compound assignment fallback (<c>x += 1</c>) otherwise.
    /// </summary>
    private BoundExpression BindBareEventOrCompoundAssignment(NameExpressionSyntax bareName, EventSubscriptionExpressionSyntax syntax)
    {
        var name = bareName.IdentifierToken.Text;
        var isAdd = syntax.OperatorToken.Kind == SyntaxKind.PlusEqualsToken;

        // Try implicit `this` event: walk the receiver type's events (including inherited).
        if (function?.ThisParameter != null && function.ReceiverType is StructSymbol receiverStruct)
        {
            for (var t = receiverStruct; t != null; t = t.BaseClass)
            {
                if (t.Events.IsDefaultOrEmpty)
                {
                    continue;
                }

                var ev = t.Events.FirstOrDefault(e => e.Name == name);
                if (ev != null)
                {
                    var receiver = new BoundVariableExpression(null, function.ThisParameter);
                    var handler = BindEventSubscriptionHandler(syntax.Value, ev.Type);
                    return new BoundEventSubscriptionExpression(null, receiver, t, ev, handler, isAdd);
                }
            }
        }

        // Not an event: fall back to compound assignment semantics.
        // Reconstruct `name = name +/- rhs` as the parser used to do.
        var boundRhs = BindExpression(syntax.Value);
        var variable = BindVariableReference(name, bareName.IdentifierToken.Location);
        if (variable == null)
        {
            return boundRhs;
        }

        // Synthesize the binary expression: variable op rhs.
        var leftExpr = BindNameExpressionCore(bareName);
        var baseOpSyntaxKind = isAdd ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;
        var leftType = leftExpr.Type;
        var op = BoundBinaryOperator.Bind(baseOpSyntaxKind, leftType, boundRhs.Type);
        if (op == null)
        {
            Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, leftType, boundRhs.Type);
            return new BoundErrorExpression(null);
        }

        var binaryResult = new BoundBinaryExpression(null, leftExpr, op, boundRhs);
        var convertedResult = conversions.BindConversion(syntax.Value.Location, binaryResult, leftType);

        // Route through the correct assignment path depending on variable kind.
        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            if (implicitField.Field.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
            }

            return new BoundFieldAssignmentExpression(null, implicitField.Receiver, implicitField.StructType, implicitField.Field, convertedResult);
        }

        if (variable is ImplicitStaticFieldVariableSymbol implicitStaticField)
        {
            if (implicitStaticField.Field.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
            }

            return new BoundFieldAssignmentExpression(null, null, implicitStaticField.StructType, implicitStaticField.Field, convertedResult);
        }

        // ADR-0053: bare static property compound assignment inside a method
        // body (shared or instance) of the enclosing type. Compound `+=`/`-=`
        // requires both a getter (for the read half) and a setter (for the
        // write half).
        if (variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp)
        {
            if (!implicitStaticProp.Property.HasGetter || !implicitStaticProp.Property.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
                return new BoundErrorExpression(null);
            }

            return new BoundPropertyAssignmentExpression(
                null,
                receiver: null,
                implicitStaticProp.StructType,
                implicitStaticProp.Property,
                convertedResult);
        }

        if (variable is ImplicitPropertyVariableSymbol implicitProp)
        {
            if (!implicitProp.Property.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
            }

            return new BoundPropertyAssignmentExpression(
                null,
                new BoundVariableExpression(null, implicitProp.Receiver),
                implicitProp.StructType,
                implicitProp.Property,
                convertedResult);
        }

        if (variable.IsReadOnly)
        {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
        }

        return new BoundAssignmentExpression(null, variable, convertedResult);
    }

    /// <summary>
    /// Issue #503 follow-up: rotates a right-associative member-access chain
    /// into the canonical left-associative form so the rightmost identifier is
    /// the immediate <see cref="AccessorExpressionSyntax.RightPart"/>. The
    /// parser produces <c>A . (B . C)</c> for <c>A.B.C</c>; this helper
    /// rewrites it as <c>(A . B) . C</c> so the event-subscription binder can
    /// treat the LHS uniformly (receiver expression on the left, event name on
    /// the right) regardless of how many segments the receiver chain has.
    /// </summary>
    private AccessorExpressionSyntax NormalizeAccessorLeftAssociative(AccessorExpressionSyntax accessor)
    {
        while (accessor.RightPart is AccessorExpressionSyntax rightChain)
        {
            var newLeft = new AccessorExpressionSyntax(
                accessor.SyntaxTree,
                accessor.LeftPart,
                accessor.DotToken,
                rightChain.LeftPart);
            accessor = new AccessorExpressionSyntax(
                accessor.SyntaxTree,
                newLeft,
                rightChain.DotToken,
                rightChain.RightPart);
        }

        return accessor;
    }

    /// <summary>
    /// Issue #503 follow-up: binds the right-hand side of an event
    /// subscription against the event's declared handler delegate type. This
    /// is the unified entry point for both user-event and CLR-event
    /// subscriptions, so method-group conversions (<c>src.Changed +=
    /// this.OnHit</c>, <c>src.Changed += OnHit</c>) are resolved consistently
    /// against the event delegate's <c>Invoke</c> signature.
    ///
    /// The helper first inspects the syntactic form of the handler:
    ///   * A bare <see cref="NameExpressionSyntax"/> that names an instance
    ///     method on the implicit <c>this</c> is bound as an instance method
    ///     group captured against <c>this</c>.
    ///   * An <see cref="AccessorExpressionSyntax"/> whose left part
    ///     evaluates to a user-defined class and whose right part names an
    ///     instance method on that class is bound as an instance method
    ///     group captured against the bound receiver.
    /// If neither pattern matches, the handler is bound through
    /// <c>BindExpression</c> as usual.
    ///
    /// Once bound, a method-group handler is routed through
    /// <c>BindConversion</c> with the event's declared delegate type
    /// so the resolved overload, target delegate, and (for instance groups)
    /// captured receiver are all known by the time the emitter runs.
    /// </summary>
    private BoundExpression BindEventSubscriptionHandler(ExpressionSyntax handlerSyntax, TypeSymbol targetDelegateType)
    {
        // Bare `OnHit` inside the declaring class: implicit-`this` instance
        // method group. Recognized before the general BindExpression because
        // a non-event name lookup would otherwise emit GS0125 for instance
        // methods (which aren't surfaced as variables).
        if (handlerSyntax is NameExpressionSyntax bareName
            && function?.ThisParameter != null
            && function.ReceiverType is StructSymbol implicitThisStruct)
        {
            var methods = implicitThisStruct.GetMethodsIncludingInherited(bareName.IdentifierToken.Text);
            if (!methods.IsDefaultOrEmpty)
            {
                var receiver = new BoundVariableExpression(null, function.ThisParameter);
                var group = BuildInstanceMethodGroup(receiver, methods);
                return conversions.BindConversion(handlerSyntax.Location, group, targetDelegateType);
            }
        }

        // `recv.OnHit` where recv is a user-defined class: bind the receiver
        // once, then surface the named instance method as a method group
        // captured against that receiver. We bind the LeftPart inline so the
        // fallback `BindExpression(handlerSyntax)` doesn't re-emit any
        // diagnostics produced during LeftPart binding.
        if (handlerSyntax is AccessorExpressionSyntax memberAccess
            && memberAccess.RightPart is NameExpressionSyntax memberName
            && !memberAccess.IsNullConditional)
        {
            var boundReceiver = BindExpression(memberAccess.LeftPart);
            if (boundReceiver is BoundErrorExpression || boundReceiver.Type == TypeSymbol.Error)
            {
                // LeftPart already reported its own diagnostic; surface the
                // error directly to avoid re-binding (and re-reporting) below.
                return boundReceiver;
            }

            if (boundReceiver.Type is StructSymbol receiverStruct)
            {
                var methods = receiverStruct.GetMethodsIncludingInherited(memberName.IdentifierToken.Text);
                if (!methods.IsDefaultOrEmpty)
                {
                    var group = BuildInstanceMethodGroup(boundReceiver, methods);
                    return conversions.BindConversion(handlerSyntax.Location, group, targetDelegateType);
                }
            }

            // Not an instance method on a user class — fall through to the
            // standard accessor binder via a synthetic accessor reusing the
            // already-bound LeftPart. The fast path is `recv.MemberName`
            // where the rebind is cheap; the slower path materializes the
            // bound receiver into a synthetic local so it isn't re-evaluated.
            return BindEventSubscriptionHandlerFromBoundAccessor(memberAccess, boundReceiver, targetDelegateType);
        }

        var bound = BindExpression(handlerSyntax);

        if (bound is BoundClrMethodGroupExpression clrGroup && clrGroup.ResolvedMethod == null)
        {
            return conversions.BindConversion(handlerSyntax.Location, clrGroup, targetDelegateType);
        }

        if (bound is BoundMethodGroupExpression userGroup)
        {
            return conversions.BindConversion(handlerSyntax.Location, userGroup, targetDelegateType);
        }

        return bound;
    }

    /// <summary>
    /// Helper for <see cref="BindEventSubscriptionHandler"/>: completes
    /// binding for an <c>obj.Member</c> handler when <c>obj</c> has already
    /// been bound (so we don't re-bind it and double-report diagnostics) and
    /// the member isn't a user-instance method. Defers to the standard
    /// accessor binder for the simple <c>name.member</c> shape; for any
    /// other shape we still re-bind the full syntax (no duplicate diagnostic
    /// risk since this branch is entered only when <c>boundReceiver</c>
    /// produced no errors).
    /// </summary>
    private BoundExpression BindEventSubscriptionHandlerFromBoundAccessor(
        AccessorExpressionSyntax memberAccess,
        BoundExpression boundReceiver,
        TypeSymbol targetDelegateType)
    {
        _ = boundReceiver;
        var bound = BindExpression(memberAccess);

        if (bound is BoundClrMethodGroupExpression clrGroup && clrGroup.ResolvedMethod == null)
        {
            return conversions.BindConversion(memberAccess.Location, clrGroup, targetDelegateType);
        }

        if (bound is BoundMethodGroupExpression userGroup)
        {
            return conversions.BindConversion(memberAccess.Location, userGroup, targetDelegateType);
        }

        return bound;
    }

    private static BoundMethodGroupExpression BuildInstanceMethodGroup(BoundExpression receiver, ImmutableArray<FunctionSymbol> methods)
    {
        if (methods.Length == 1)
        {
            var only = methods[0];
            var paramTypes = ImmutableArray.CreateBuilder<TypeSymbol>(only.Parameters.Length);
            foreach (var p in only.Parameters)
            {
                paramTypes.Add(p.Type);
            }

            var fnType = FunctionTypeSymbol.Get(paramTypes.MoveToImmutable(), only.Type ?? TypeSymbol.Void);
            return new BoundMethodGroupExpression(null, receiver, only, fnType);
        }

        return new BoundMethodGroupExpression(null, receiver, methods);
    }

    /// <summary>
    /// ADR-0053: bind <c>Type.StaticField +=/-= rhs</c> or
    /// <c>Type.StaticProp +=/-= rhs</c> where <paramref name="staticStruct"/>
    /// is the user-defined receiver type. Returns <c>true</c> if the named
    /// member was a static field/property and the compound assignment was
    /// produced; <c>false</c> if no static field or property by that name
    /// exists on the type (caller falls through to error reporting).
    /// Mirrors the static branch of <see cref="BindFieldAssignmentExpression"/>
    /// (lines ~6586–6619) but for compound `+=` / `-=`.
    /// </summary>
    private bool TryBindUserTypeStaticCompoundAssignment(
        StructSymbol staticStruct,
        NameExpressionSyntax memberNameSyntax,
        EventSubscriptionExpressionSyntax syntax,
        bool isAdd,
        out BoundExpression result)
    {
        var memberName = memberNameSyntax.IdentifierToken.Text;
        var baseOpSyntaxKind = isAdd ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;
        var boundRhs = BindExpression(syntax.Value);

        if (staticStruct.TryGetStaticField(memberName, out var staticField))
        {
            var leftRead = new BoundFieldAccessExpression(null, receiver: null, staticStruct, staticField);
            var op = BoundBinaryOperator.Bind(baseOpSyntaxKind, staticField.Type, boundRhs.Type);
            if (op == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, staticField.Type, boundRhs.Type);
                result = new BoundErrorExpression(null);
                return true;
            }

            if (staticField.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName);
            }

            var binary = new BoundBinaryExpression(null, leftRead, op, boundRhs);
            var converted = conversions.BindConversion(syntax.Value.Location, binary, staticField.Type);
            result = new BoundFieldAssignmentExpression(null, null, staticStruct, staticField, converted);
            return true;
        }

        foreach (var prop in staticStruct.StaticProperties)
        {
            if (prop.Name != memberName)
            {
                continue;
            }

            if (!prop.HasGetter || !prop.HasSetter)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, memberName);
                result = new BoundErrorExpression(null);
                return true;
            }

            var leftRead = new BoundPropertyAccessExpression(null, receiver: null, staticStruct, prop);
            var op = BoundBinaryOperator.Bind(baseOpSyntaxKind, prop.Type, boundRhs.Type);
            if (op == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, prop.Type, boundRhs.Type);
                result = new BoundErrorExpression(null);
                return true;
            }

            var binary = new BoundBinaryExpression(null, leftRead, op, boundRhs);
            var converted = conversions.BindConversion(syntax.Value.Location, binary, prop.Type);
            result = new BoundPropertyAssignmentExpression(null, receiver: null, staticStruct, prop, converted);
            return true;
        }

        result = null;
        return false;
    }

    /// <summary>
    /// Binds a name expression to produce its bound form without side effects
    /// (used by compound assignment fallback to read the current value).
    /// </summary>
    private BoundExpression BindNameExpressionCore(NameExpressionSyntax syntax)
    {
        return BindNameExpression(syntax);
    }

    private static bool IsSignatureCompatibleWithDelegate(FunctionTypeSymbol fn, Type delegateType)
    {
        if (delegateType == null || !typeof(Delegate).IsAssignableFrom(delegateType))
        {
            return false;
        }

        var invoke = delegateType.GetMethod("Invoke");
        if (invoke == null)
        {
            return false;
        }

        var parms = invoke.GetParameters();
        if (parms.Length != fn.ParameterTypes.Length)
        {
            return false;
        }

        for (var i = 0; i < parms.Length; i++)
        {
            if (fn.ParameterTypes[i]?.ClrType != parms[i].ParameterType)
            {
                return false;
            }
        }

        var fnRetClr = fn.ReturnType == TypeSymbol.Void ? typeof(void) : fn.ReturnType?.ClrType;
        return fnRetClr == invoke.ReturnType;
    }

    private static bool TryGetWritableClrMember(MemberInfo member, out Type targetType, out TypeSymbol targetTypeSymbol, out bool writable)
    {
        switch (member)
        {
            case PropertyInfo p:
                targetType = p.PropertyType;
                targetTypeSymbol = ClrNullability.GetPropertyTypeSymbol(p);
                writable = p.CanWrite && p.GetSetMethod(nonPublic: false) != null;
                return writable;
            case FieldInfo f:
                targetType = f.FieldType;
                targetTypeSymbol = ClrNullability.GetFieldTypeSymbol(f);
                writable = !f.IsInitOnly && !f.IsLiteral;
                return writable;
            default:
                targetType = null;
                targetTypeSymbol = null;
                writable = false;
                return false;
        }
    }

    private BoundExpression BindUnaryExpression(UnaryExpressionSyntax syntax)
    {
        // Phase 5.5 / ADR-0022: prefix `<-ch` is a channel-receive expression,
        // not a unary operator. Route to a dedicated binder so the operator
        // table doesn't need a per-element-type entry.
        if (syntax.OperatorToken.Kind == SyntaxKind.LeftArrowToken)
        {
            return BindChannelReceiveExpression(syntax);
        }

        // ADR-0039: `&expr` — address-of (managed by-ref pointer).
        if (syntax.OperatorToken.Kind == SyntaxKind.AmpersandToken)
        {
            return BindAddressOfExpression(syntax);
        }

        // ADR-0039: `*expr` — dereference a by-ref pointer.
        if (syntax.OperatorToken.Kind == SyntaxKind.StarToken)
        {
            return BindDereferenceExpression(syntax);
        }

        var boundOperand = BindExpression(syntax.Operand);

        if (boundOperand.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var boundOperator = BoundUnaryOperator.Bind(syntax.OperatorToken.Kind, boundOperand.Type);

        if (boundOperator == null)
        {
            // Stream D: try user-defined `func (a T) operator <op>() R` on the
            // operand's user type. Same-package methods bind onto the struct
            // (Phase 6.4); the receiver is Parameters[0] (Parameters.Length==1
            // for unary ops). Extension-function fallback also covered.
            var userOpName = OperatorNames.TryGetUnaryName(syntax.OperatorToken.Kind);
            if (userOpName != null && boundOperand.Type != null)
            {
                FunctionSymbol userOp = null;
                bool isStructReceiver = false;
                if (boundOperand.Type is StructSymbol operandStruct && operandStruct.TryGetMethodIncludingInherited(userOpName, out var structOp))
                {
                    userOp = structOp;
                    isStructReceiver = true;
                }
                else if (scope.TryLookupExtensionFunction(boundOperand.Type, userOpName, out var extOp))
                {
                    userOp = extOp;
                }

                if (userOp != null && userOp.Parameters.Length == 1)
                {
                    var convertedOperand = conversions.BindConversion(syntax.Operand.Location, boundOperand, userOp.Parameters[0].Type);
                    if (isStructReceiver)
                    {
                        return new BoundUserInstanceCallExpression(null, convertedOperand, userOp, ImmutableArray<BoundExpression>.Empty);
                    }

                    return new BoundCallExpression(null, userOp, ImmutableArray.Create(convertedOperand));
                }
            }

            // Stream C: fall back to a public-static unary `op_*` method on
            // the operand's CLR type (`-time`, `~bits`, ...).
            var ambiguous = false;
            if (boundOperand.Type?.ClrType != null
                && ClrOperatorResolution.TryResolveUnary(syntax.OperatorToken.Kind, boundOperand.Type, out var clrMethod, out ambiguous))
            {
                return new BoundClrUnaryOperatorExpression(
                    null,
                    syntax.OperatorToken.Kind,
                    boundOperand,
                    clrMethod,
                    TypeSymbol.FromClrType(clrMethod.ReturnType));
            }
            else if (ambiguous)
            {
                Diagnostics.ReportAmbiguousOverload(syntax.OperatorToken.Location, syntax.OperatorToken.Text, candidateCount: 2);
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportUndefinedUnaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, boundOperand.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundUnaryExpression(null, boundOperator, boundOperand);
    }

    /// <summary>ADR-0039: Binds <c>&amp;expr</c> — takes managed pointer to an lvalue.</summary>
    private BoundExpression BindAddressOfExpression(UnaryExpressionSyntax syntax)
    {
        // ADR-0061: `&(cond ? a : b)` and `&cond ? a : b` (parser tail
        // form). Dispatch to the conditional ref-argument binder, which
        // produces a BoundConditionalAddressExpression of type `T&`.
        // The operand may be wrapped in parens by the parser; unwrap.
        var rawOperand = syntax.Operand;
        while (rawOperand is ParenthesizedExpressionSyntax pen)
        {
            rawOperand = pen.Expression;
        }

        if (rawOperand is ConditionalRefArgumentExpressionSyntax condOperand)
        {
            return conversions.BindConditionalRefArgument(condOperand, outerModifier: null);
        }

        // ADR-0062: a general conditional expression as the operand of `&`
        // binds to the conditional-address path (preserving ADR-0061 byref
        // safety) when both arms are lvalues of a common pointee type.
        if (rawOperand is ConditionalExpressionSyntax generalCond)
        {
            return BindConditionalAddressFromGeneral(generalCond, outerModifier: null);
        }

        var operand = BindExpression(syntax.Operand);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        // GS9005: cannot take address of a constant binding.
        if (operand is BoundVariableExpression bve && bve.Variable.IsReadOnly)
        {
            // ADR-0060: address-of an `in` parameter would let callers write
            // through the pointer, defeating the read-only contract. Report
            // GS0237 instead of the generic "cannot take address of constant".
            if (bve.Variable is ParameterSymbol inParam && inParam.RefKind == RefKind.In)
            {
                Diagnostics.ReportCannotAssignToInParameter(syntax.OperatorToken.Location, inParam.Name);
            }
            else
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.OperatorToken.Location, bve.Variable.Name);
            }

            return new BoundErrorExpression(null);
        }

        // Lvalue check.
        if (!IsLvalue(operand))
        {
            var exprText = syntax.Operand.ToString();
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.OperatorToken.Location, exprText);
            return new BoundErrorExpression(null);
        }

        return new BoundAddressOfExpression(null, operand);
    }

    /// <summary>ADR-0039: Binds <c>*expr</c> — dereferences a managed pointer.</summary>
    private BoundExpression BindDereferenceExpression(UnaryExpressionSyntax syntax)
    {
        var operand = BindExpression(syntax.Operand);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        if (operand.Type is not ByRefTypeSymbol)
        {
            Diagnostics.ReportUndefinedUnaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, operand.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundDereferenceExpression(null, operand);
    }

    /// <summary>
    /// ADR-0060 §13: binds an indirect assignment <c>*p = expr</c>. The left-hand
    /// side must be a unary dereference of a pointer expression; the result is a
    /// <see cref="BoundIndirectAssignmentExpression"/> whose value type is the
    /// pointee type.
    /// </summary>
    /// <param name="syntax">The indirect-assignment syntax.</param>
    /// <returns>The bound expression, or an error expression on failure.</returns>
    private BoundExpression BindIndirectAssignmentExpression(IndirectAssignmentExpressionSyntax syntax)
    {
        var pointer = BindExpression(syntax.Target.Operand);
        if (pointer is BoundErrorExpression)
        {
            return pointer;
        }

        if (pointer.Type is not ByRefTypeSymbol byRef)
        {
            Diagnostics.ReportUndefinedUnaryOperator(syntax.Target.OperatorToken.Location, syntax.Target.OperatorToken.Text, pointer.Type);
            return new BoundErrorExpression(null);
        }

        var value = BindExpression(syntax.Value);
        if (value is BoundErrorExpression)
        {
            return value;
        }

        if (value.Type != byRef.PointeeType && value.Type != TypeSymbol.Error)
        {
            var converted = Conversion.Classify(value.Type, byRef.PointeeType);
            if (!converted.IsImplicit)
            {
                Diagnostics.ReportCannotConvert(syntax.Value.Location, value.Type, byRef.PointeeType);
                return new BoundErrorExpression(null);
            }

            value = new BoundConversionExpression(null, byRef.PointeeType, value);
        }

        return new BoundIndirectAssignmentExpression(syntax, pointer, value);
    }

    /// <summary>
    /// ADR-0060: binds a <c>ref</c>/<c>out</c>/<c>in</c> argument-position expression.
    /// For the lvalue form (e.g. <c>ref x</c>, <c>out result</c>, <c>in rect</c>) the
    /// inner expression is bound to a <see cref="BoundAddressOfExpression"/>. For the
    /// inline-declaration / discard form (<c>out var name</c>, <c>out let name</c>,
    /// <c>out _</c>), a synthesized <see cref="LocalVariableSymbol"/> is registered in
    /// the current scope (with the declared type, or — if omitted — the parameter's
    /// pointee type) and the address-of expression wraps it.
    /// </summary>
    /// <param name="syntax">The ref-kind argument syntax.</param>
    /// <param name="parameter">The callee parameter this argument binds to (may be <see langword="null"/> when unresolved).</param>
    /// <returns>The bound address-of expression, or an error expression on failure.</returns>
    private BoundExpression BindRefArgumentExpression(RefArgumentExpressionSyntax syntax, ParameterSymbol parameter)
    {
        if (syntax.IsInlineDeclaration)
        {
            // ADR-0060 §1: `out var n [T]` / `out let n [T]` / `out _ [T]`.
            // Only legal when the modifier is `out` AND the parameter (if known) is `out`.
            if (!string.Equals(syntax.RefKindModifier.Text, "out", System.StringComparison.Ordinal))
            {
                Diagnostics.ReportOutDeclarationOutsideOutArgument(syntax.Location);
                return new BoundErrorExpression(null);
            }

            TypeSymbol declaredType = null;
            if (syntax.DeclaredType != null)
            {
                declaredType = BindTypeClause(syntax.DeclaredType);
            }

            if (declaredType == null && parameter != null)
            {
                declaredType = parameter.Type;
            }

            // ADR-0060: in the first pass (called from BindCallExpression before
            // overload resolution), the parameter is unknown and no explicit
            // type was given. Return a placeholder bound node *without*
            // declaring a local — the call-site arg-loop re-binds us once the
            // parameter has been resolved so the local has the right type.
            if (declaredType == null)
            {
                return new BoundAddressOfExpression(null, new BoundErrorExpression(null));
            }

            // Synthesize the local. `out _` gets a fresh anonymous name; `out var`/`out let`
            // honour the user-given identifier.
            bool isReadOnly = syntax.DeclarationKeyword != null
                && string.Equals(syntax.DeclarationKeyword.Text, "let", System.StringComparison.Ordinal);
            string localName;
            if (syntax.DiscardToken != null)
            {
                localName = $"<>out_discard_{binderCtx.OutDiscardCounter++}";
            }
            else
            {
                localName = syntax.DeclarationIdentifier.Text;
            }

            var local = new LocalVariableSymbol(localName, isReadOnly, declaredType, declaringSyntax: syntax);
            if (syntax.DiscardToken == null && !scope.TryDeclareVariable(local))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.DeclarationIdentifier.Location, localName);
                return new BoundErrorExpression(null);
            }
            else if (syntax.DiscardToken != null)
            {
                // Discards never collide; always declare under the synthesized name.
                scope.TryDeclareVariable(local);
            }

            var nameExpression = new BoundVariableExpression(null, local);
            return new BoundAddressOfExpression(null, nameExpression);
        }

        // Plain lvalue form: bind the operand and check it's an lvalue.
        // ADR-0061: the operand may be a conditional ref-argument expression
        // (`cond ? a : b`); dispatch to the dedicated binder which produces
        // a BoundConditionalAddressExpression (also typed `T&`). The
        // operand may be wrapped in parens (`ref (cond ? a : b)`); unwrap.
        var rawExpr = syntax.Expression;
        while (rawExpr is ParenthesizedExpressionSyntax pen)
        {
            rawExpr = pen.Expression;
        }

        if (rawExpr is ConditionalRefArgumentExpressionSyntax condSyntax)
        {
            return conversions.BindConditionalRefArgument(condSyntax, syntax.RefKindModifier);
        }

        // ADR-0062: a general conditional expression as the payload of
        // ref/out/in binds to the conditional-address path (preserving
        // ADR-0061 byref safety).
        if (rawExpr is ConditionalExpressionSyntax generalCondSyntax)
        {
            return BindConditionalAddressFromGeneral(generalCondSyntax, syntax.RefKindModifier);
        }

        var operand = BindExpression(syntax.Expression);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        if (!IsLvalue(operand))
        {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.RefKindModifier.Location, syntax.Expression.ToString());
            return new BoundErrorExpression(null);
        }

        // For `out` we allow writes to a read-only target only if it's an
        // out-parameter or a writable local. The existing GS9005 check fires
        // for true constants; preserve that for `ref` (read-only operand is
        // fine for `in`).
        if (operand is BoundVariableExpression vex && vex.Variable.IsReadOnly
            && string.Equals(syntax.RefKindModifier.Text, "ref", System.StringComparison.Ordinal))
        {
            Diagnostics.ReportCannotTakeAddressOfConstant(syntax.RefKindModifier.Location, vex.Variable.Name);
            return new BoundErrorExpression(null);
        }

        return new BoundAddressOfExpression(null, operand);
    }

    /// <summary>
    /// ADR-0062: binds a general conditional expression as a conditional
    /// address-of when used as the payload of a ref-kind modifier or as the
    /// operand of <c>&amp;</c>. Reuses the same validation rules as
    /// <see cref="ConversionClassifier.BindConditionalRefArgument"/> minus the inner-modifier
    /// checks (which the generalized syntax does not carry).
    /// </summary>
    /// <param name="syntax">The general conditional expression syntax.</param>
    /// <param name="outerModifier">The outer ref-kind modifier token (<see langword="null"/> for the bare <c>&amp;</c> operand form).</param>
    /// <returns>The bound conditional address expression, or a <see cref="BoundErrorExpression"/> on failure.</returns>
    private BoundExpression BindConditionalAddressFromGeneral(
        ConditionalExpressionSyntax syntax,
        SyntaxToken outerModifier)
    {
        // Condition must be bool.
        var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);

        var whenTrue = BindExpression(syntax.WhenTrue);
        var whenFalse = BindExpression(syntax.WhenFalse);

        if (whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression || condition is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        if (!IsLvalue(whenTrue))
        {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.WhenTrue.Location, syntax.WhenTrue.ToString());
            return new BoundErrorExpression(null);
        }

        if (!IsLvalue(whenFalse))
        {
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.WhenFalse.Location, syntax.WhenFalse.ToString());
            return new BoundErrorExpression(null);
        }

        // Branch types must match exactly — no implicit widening, since the
        // resulting byref selects between slots whose physical type must agree.
        if (!ReferenceEquals(whenTrue.Type, whenFalse.Type)
            && !string.Equals(whenTrue.Type?.Name, whenFalse.Type?.Name, System.StringComparison.Ordinal))
        {
            Diagnostics.ReportConditionalRefArgumentBranchTypeMismatch(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?");
            return new BoundErrorExpression(null);
        }

        string outerText = outerModifier?.Text ?? "&";
        bool requiresWritable = outerText == "ref" || outerText == "out" || outerText == "&";
        if (requiresWritable)
        {
            if (whenTrue is BoundVariableExpression wtVar && wtVar.Variable.IsReadOnly)
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.WhenTrue.Location, wtVar.Variable.Name);
                return new BoundErrorExpression(null);
            }

            if (whenFalse is BoundVariableExpression wfVar && wfVar.Variable.IsReadOnly)
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.WhenFalse.Location, wfVar.Variable.Name);
                return new BoundErrorExpression(null);
            }
        }

        return new BoundConditionalAddressExpression(null, condition, whenTrue, whenFalse, whenTrue.Type);
    }

    /// <summary>
    /// ADR-0062: binds a general two-arm conditional expression in value
    /// context. Validates the condition is <c>bool</c>, computes a common
    /// result type using identity / one-way implicit conversion / numeric
    /// tie-break rules, and produces a <see cref="BoundConditionalExpression"/>.
    /// </summary>
    /// <param name="syntax">The conditional expression syntax.</param>
    /// <returns>The bound conditional expression, or a <see cref="BoundErrorExpression"/> on failure.</returns>
    private BoundExpression BindConditionalExpression(ConditionalExpressionSyntax syntax)
    {
        var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);
        var whenTrue = BindExpression(syntax.WhenTrue);
        var whenFalse = BindExpression(syntax.WhenFalse);

        if (condition is BoundErrorExpression || whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        var resultType = ComputeConditionalCommonType(whenTrue.Type, whenFalse.Type);
        if (resultType == null)
        {
            Diagnostics.ReportConditionalNoCommonResultType(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?");
            return new BoundErrorExpression(null);
        }

        var convertedTrue = ConvertConditionalBranch(syntax.WhenTrue.Location, whenTrue, resultType);
        var convertedFalse = ConvertConditionalBranch(syntax.WhenFalse.Location, whenFalse, resultType);
        if (convertedTrue is BoundErrorExpression || convertedFalse is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        return new BoundConditionalExpression(null, condition, convertedTrue, convertedFalse, resultType);
    }

    /// <summary>
    /// ADR-0062: chooses a common result type for two conditional branches
    /// using the following ordered rules (mirroring the ADR §2 common-type
    /// procedure):
    /// <list type="number">
    ///   <item><description>Identity (<c>Tx == Ty</c>).</description></item>
    ///   <item><description>One-way implicit conversion (<c>Tx → Ty</c> but not <c>Ty → Tx</c>, or vice versa).</description></item>
    ///   <item><description>Both convertible implicitly — pick the wider via the numeric tie-break rule (ADR-0037) when both are numeric; otherwise no common type.</description></item>
    ///   <item><description><c>nil</c> compatibility — when one arm is the nil/null sentinel and the other is reference- or nullable-compatible, use the other arm's type.</description></item>
    /// </list>
    /// Returns <see langword="null"/> when no common type exists.
    /// </summary>
    /// <param name="left">The true-arm type.</param>
    /// <param name="right">The false-arm type.</param>
    /// <returns>The chosen common type, or <see langword="null"/>.</returns>
    private static TypeSymbol ComputeConditionalCommonType(TypeSymbol left, TypeSymbol right)
    {
        if (left == null || right == null)
        {
            return null;
        }

        if (left == TypeSymbol.Error || right == TypeSymbol.Error)
        {
            return TypeSymbol.Error;
        }

        // Identity.
        if (ReferenceEquals(left, right))
        {
            return left;
        }

        // Nil/null compatibility: when one arm is the null sentinel and the
        // other is non-null, pick the non-null. The conversion machinery
        // accepts the trivial null → reference/nullable widening.
        if (left == TypeSymbol.Null)
        {
            return right;
        }

        if (right == TypeSymbol.Null)
        {
            return left;
        }

        var leftToRight = Conversion.Classify(left, right);
        var rightToLeft = Conversion.Classify(right, left);

        bool leftImplicit = leftToRight.IsImplicit;
        bool rightImplicit = rightToLeft.IsImplicit;

        // Identity already handled; treat IsIdentity here as implicit too.
        if (leftImplicit && !rightImplicit)
        {
            return right;
        }

        if (rightImplicit && !leftImplicit)
        {
            return left;
        }

        if (leftImplicit && rightImplicit)
        {
            // ADR-0037 numeric tie-break: prefer the wider canonical numeric
            // target when both arms are numeric.
            var widened = TryNumericTieBreak(left, right);
            if (widened != null)
            {
                return widened;
            }

            // Both convert to each other and neither is numeric — they're
            // effectively identical; pick the left arm deterministically.
            return left;
        }

        return null;
    }

    /// <summary>
    /// ADR-0037-style numeric tie-break: when both arms are numeric primitives,
    /// pick the wider canonical type using a simple rank. Returns
    /// <see langword="null"/> when either type isn't a recognised primitive.
    /// </summary>
    private static TypeSymbol TryNumericTieBreak(TypeSymbol a, TypeSymbol b)
    {
        int ra = NumericRank(a);
        int rb = NumericRank(b);
        if (ra == 0 || rb == 0)
        {
            return null;
        }

        return ra >= rb ? a : b;
    }

    private static int NumericRank(TypeSymbol t)
    {
        if (t == TypeSymbol.Int8 || t == TypeSymbol.UInt8)
        {
            return 1;
        }

        if (t == TypeSymbol.Int16 || t == TypeSymbol.UInt16)
        {
            return 2;
        }

        if (t == TypeSymbol.Int32 || t == TypeSymbol.UInt32)
        {
            return 3;
        }

        if (t == TypeSymbol.Int64 || t == TypeSymbol.UInt64)
        {
            return 4;
        }

        if (t == TypeSymbol.Float32)
        {
            return 5;
        }

        if (t == TypeSymbol.Float64)
        {
            return 6;
        }

        return 0;
    }

    private BoundExpression ConvertConditionalBranch(TextLocation location, BoundExpression branch, TypeSymbol target)
    {
        if (target == TypeSymbol.Error || branch.Type == TypeSymbol.Error)
        {
            return branch;
        }

        if (ReferenceEquals(branch.Type, target))
        {
            return branch;
        }

        return conversions.BindConversion(location, branch, target);
    }

    /// <summary>ADR-0060: human-readable label for a <see cref="RefKind"/>.</summary>
    /// <param name="kind">The ref-kind value.</param>
    /// <returns>"none", "ref", "out", or "in".</returns>
    private static string RefKindToString(RefKind kind) => kind switch
    {
        RefKind.Ref => "ref",
        RefKind.Out => "out",
        RefKind.In => "in",
        _ => "none",
    };

    /// <summary>
    /// ADR-0063: render a function's signature in a human-readable form for diagnostics.
    /// </summary>
    /// <param name="function">The function whose signature should be formatted.</param>
    /// <returns>A human-readable signature string (e.g. <c>F(in int, out string)</c>).</returns>
    internal static string FormatOverloadSignature(FunctionSymbol function)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(function.Name);
        sb.Append('(');
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            var p = function.Parameters[i];
            if (p.RefKind != RefKind.None)
            {
                sb.Append(RefKindToString(p.RefKind));
                sb.Append(' ');
            }

            sb.Append(p.Type?.Name ?? "?");
        }

        sb.Append(')');
        return sb.ToString();
    }

    /// <summary>
    /// ADR-0060: maps a ref-kind modifier syntax token to a <see cref="RefKind"/> value.
    /// </summary>
    /// <param name="modifier">The <c>ref</c>/<c>out</c>/<c>in</c> contextual-keyword token (<see langword="null"/> for none).</param>
    /// <returns>The corresponding <see cref="RefKind"/> value.</returns>
    private static RefKind GetRefKindFromModifier(SyntaxToken modifier)
    {
        if (modifier == null)
        {
            return RefKind.None;
        }

        return modifier.Text switch
        {
            "ref" => RefKind.Ref,
            "out" => RefKind.Out,
            "in" => RefKind.In,
            _ => RefKind.None,
        };
    }

    /// <summary>ADR-0039: Determines whether an expression is an lvalue (can have its address taken).</summary>
    private static bool IsLvalue(BoundExpression expression)
    {
        return expression is BoundVariableExpression
            or BoundFieldAccessExpression
            or BoundIndexExpression
            or BoundDereferenceExpression;
    }

    /// <summary>ADR-0039: Computes per-argument <see cref="RefKind"/> from CLR parameter metadata.</summary>
    /// <summary>
    /// Issue #368 / ADR-0055: rewrites any interpolated-string argument passed to
    /// a parameter typed as a user-defined <c>[InterpolatedStringHandler]</c> so
    /// that it carries the resolved handler-construction target. The referenced
    /// surrounding arguments / receiver named by
    /// <c>[InterpolatedStringHandlerArgument]</c> are captured and forwarded into
    /// the handler constructor by the emit lowerer. Arguments that are not
    /// handler-targeted interpolations are returned unchanged.
    /// </summary>
    /// <param name="parameters">The resolved method's/constructor's parameters.</param>
    /// <param name="arguments">The bound positional arguments (aligned with the leading parameters).</param>
    /// <param name="receiver">The instance receiver, or <see langword="null"/> for static/constructor calls.</param>
    /// <param name="location">The diagnostic location for the call.</param>
    /// <param name="parameterMapping">Issue #343: per-source-argument → parameter-position map; default for identity.</param>
    /// <returns>The arguments, with handler-targeted interpolations rewritten.</returns>
    private ImmutableArray<BoundExpression> ApplyInterpolatedStringHandlers(
        System.Reflection.ParameterInfo[] parameters,
        ImmutableArray<BoundExpression> arguments,
        BoundExpression receiver,
        TextLocation location,
        ImmutableArray<int> parameterMapping = default)
    {
        if (parameters == null || arguments.IsDefaultOrEmpty)
        {
            return arguments;
        }

        ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            if (arguments[i] is not BoundInterpolatedStringExpression interp || interp.Handler != null)
            {
                continue;
            }

            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            if (paramIndex >= parameters.Length)
            {
                continue;
            }

            var parameterType = parameters[paramIndex].ParameterType;

            // V1 supports by-value handler parameters only; a by-ref handler
            // parameter (e.g. StringBuilder.Append(ref AppendInterpolatedStringHandler))
            // would require passing the handler local by address, which the call
            // sites here do not arrange.
            if (parameterType.IsByRef || !InterpolatedStringHandlerInfo.IsHandlerType(parameterType))
            {
                continue;
            }

            var handler = InterpolatedStringHandlerInfo.TryCreate(
                parameterType,
                parameters[paramIndex],
                parameters,
                arguments,
                receiver,
                out var failure);
            if (handler == null)
            {
                Diagnostics.ReportInterpolatedStringHandlerArgument(location, failure);
                continue;
            }

            builder ??= arguments.ToBuilder();
            builder[i] = interp.Update(interp.Parts, handler);
        }

        return builder?.ToImmutable() ?? arguments;
    }

    private static ImmutableArray<RefKind> ComputeArgumentRefKinds(System.Reflection.ParameterInfo[] parameters)
    {
        var hasAnyRef = false;
        for (int i = 0; i < parameters.Length; i++)
        {
            if (parameters[i].ParameterType.IsByRef)
            {
                hasAnyRef = true;
                break;
            }
        }

        if (!hasAnyRef)
        {
            return default;
        }

        var builder = ImmutableArray.CreateBuilder<RefKind>(parameters.Length);
        for (int i = 0; i < parameters.Length; i++)
        {
            var p = parameters[i];
            if (!p.ParameterType.IsByRef)
            {
                builder.Add(RefKind.None);
            }
            else if (p.IsOut && !p.IsIn)
            {
                builder.Add(RefKind.Out);
            }
            else if (p.IsIn && !p.IsOut)
            {
                builder.Add(RefKind.In);
            }
            else
            {
                builder.Add(RefKind.Ref);
            }
        }

        return builder.MoveToImmutable();
    }

    private BoundExpression BindChannelReceiveExpression(UnaryExpressionSyntax syntax)
    {
        var operand = BindExpression(syntax.Operand);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        if (operand.Type is not ChannelTypeSymbol chan)
        {
            Diagnostics.ReportReceiveOperandIsNotChannel(syntax.Operand.Location, operand.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundChannelReceiveExpression(null, operand, chan.ElementType);
    }

    private BoundExpression BindBinaryExpression(BinaryExpressionSyntax syntax)
    {
        var boundLeft = BindExpression(syntax.Left);
        var boundRight = BindExpression(syntax.Right);

        if (boundLeft.Type == TypeSymbol.Error || boundRight.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var boundOperator = BoundBinaryOperator.Bind(syntax.OperatorToken.Kind, boundLeft.Type, boundRight.Type);

        if (boundOperator == null)
        {
            // Stream D: try user-defined `func (a T) operator <op>(b U) R` on
            // either operand's user type. Same-package operators are bound as
            // methods on the struct (Phase 6.4); the receiver is at
            // Parameters[0] (so binary ops have Parameters.Length == 2).
            var userOpName = OperatorNames.TryGetBinaryName(syntax.OperatorToken.Kind);
            if (userOpName != null)
            {
                FunctionSymbol userOp = null;
                bool leftIsStructReceiver = false;
                bool rightIsStructReceiver = false;
                if (boundLeft.Type is StructSymbol leftStruct && leftStruct.TryGetMethodIncludingInherited(userOpName, out var leftOp))
                {
                    userOp = leftOp;
                    leftIsStructReceiver = true;
                }
                else if (boundRight.Type is StructSymbol rightStruct && rightStruct.TryGetMethodIncludingInherited(userOpName, out var rightOp))
                {
                    userOp = rightOp;
                    rightIsStructReceiver = true;
                }
                else if (boundLeft.Type != null && scope.TryLookupExtensionFunction(boundLeft.Type, userOpName, out var leftExt))
                {
                    userOp = leftExt;
                }
                else if (boundRight.Type != null && scope.TryLookupExtensionFunction(boundRight.Type, userOpName, out var rightExt))
                {
                    userOp = rightExt;
                }

                if (userOp != null && userOp.Parameters.Length == 2)
                {
                    var convertedLeft = conversions.BindConversion(syntax.Left.Location, boundLeft, userOp.Parameters[0].Type);
                    var convertedRight = conversions.BindConversion(syntax.Right.Location, boundRight, userOp.Parameters[1].Type);
                    if (leftIsStructReceiver)
                    {
                        return new BoundUserInstanceCallExpression(null, convertedLeft, userOp, ImmutableArray.Create(convertedRight));
                    }

                    if (rightIsStructReceiver)
                    {
                        return new BoundUserInstanceCallExpression(null, convertedRight, userOp, ImmutableArray.Create(convertedLeft));
                    }

                    return new BoundCallExpression(null, userOp, ImmutableArray.Create(convertedLeft, convertedRight));
                }
            }

            // Stream C: fall back to a public-static `op_*` method on either
            // operand's CLR type (TimeSpan + TimeSpan, BigInteger * int, ...).
            var ambiguous = false;
            if ((boundLeft.Type?.ClrType != null || boundRight.Type?.ClrType != null)
                && ClrOperatorResolution.TryResolveBinary(syntax.OperatorToken.Kind, boundLeft.Type, boundRight.Type, out var clrMethod, out ambiguous))
            {
                return new BoundClrBinaryOperatorExpression(
                    null,
                    syntax.OperatorToken.Kind,
                    boundLeft,
                    boundRight,
                    clrMethod,
                    TypeSymbol.FromClrType(clrMethod.ReturnType));
            }
            else if (ambiguous)
            {
                Diagnostics.ReportAmbiguousOverload(syntax.OperatorToken.Location, syntax.OperatorToken.Text, candidateCount: 2);
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, boundLeft.Type, boundRight.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundBinaryExpression(null, boundLeft, boundOperator, boundRight);
    }

    private static void InferTypeArguments(TypeSymbol parameterType, TypeSymbol argumentType, Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        if (parameterType is TypeParameterSymbol tp)
        {
            // First seen value wins. Cross-arg consistency is verified later
            // by the post-substitution argument-type check.
            if (!substitution.ContainsKey(tp))
            {
                substitution[tp] = argumentType;
            }

            return;
        }

        if (parameterType is NullableTypeSymbol pn && argumentType is NullableTypeSymbol an)
        {
            InferTypeArguments(pn.UnderlyingType, an.UnderlyingType, substitution);
        }
        else if (parameterType is SliceTypeSymbol ps && argumentType is SliceTypeSymbol asym)
        {
            InferTypeArguments(ps.ElementType, asym.ElementType, substitution);
        }
        else if (parameterType is ArrayTypeSymbol pa && argumentType is ArrayTypeSymbol aa)
        {
            InferTypeArguments(pa.ElementType, aa.ElementType, substitution);
        }
        else if (parameterType is FunctionTypeSymbol pf && argumentType is FunctionTypeSymbol af
            && pf.ParameterTypes.Length == af.ParameterTypes.Length)
        {
            // Infer type parameters that appear inside a delegate parameter,
            // e.g. `f func(T) U` matched against `func(int32) bool` yields
            // T -> int32, U -> bool.
            for (var i = 0; i < pf.ParameterTypes.Length; i++)
            {
                InferTypeArguments(pf.ParameterTypes[i], af.ParameterTypes[i], substitution);
            }

            InferTypeArguments(pf.ReturnType, af.ReturnType, substitution);
        }
        else if (parameterType is ImportedTypeSymbol pit && pit.HasTypeParameterArgument)
        {
            // #313: infer from a generic type parameterized by an in-scope type
            // parameter (e.g. parameter `List[T]` matched against argument
            // `List<int32>`). Unify the symbolic type arguments positionally
            // against the argument's CLR generic arguments.
            var argClrArgs = GetClrGenericArguments(argumentType);
            if (!argClrArgs.IsDefaultOrEmpty && argClrArgs.Length == pit.TypeArguments.Length)
            {
                for (var i = 0; i < pit.TypeArguments.Length; i++)
                {
                    InferTypeArguments(pit.TypeArguments[i], argClrArgs[i], substitution);
                }
            }
        }
    }

    // #313: surface the CLR generic arguments of an argument type (e.g. the
    // `int32` of a `List<int32>` argument) as GSharp type symbols, so they can
    // be unified positionally against the symbolic arguments of a `List[T]`
    // parameter during type-argument inference.
    private static ImmutableArray<TypeSymbol> GetClrGenericArguments(TypeSymbol type)
    {
        if (type is ImportedTypeSymbol it && !it.TypeArguments.IsDefaultOrEmpty)
        {
            return it.TypeArguments;
        }

        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType)
        {
            return ImmutableArray<TypeSymbol>.Empty;
        }

        var args = clr.GetGenericArguments();
        var builder = ImmutableArray.CreateBuilder<TypeSymbol>(args.Length);
        foreach (var a in args)
        {
            builder.Add(TypeSymbol.FromClrType(a));
        }

        return builder.MoveToImmutable();
    }

    private static bool TryGetTaskElementType(TypeSymbol type, out TypeSymbol element)
    {
        element = null;
        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        // Use the general awaitable-shape resolver: any type with a conforming
        // GetAwaiter()/IsCompleted/GetResult() triple is awaitable (C# spec §12.9.8).
        var shape = AwaitableShape.Resolve(clr);
        if (shape == null)
        {
            return false;
        }

        var resultClrType = shape.ResultType;
        if (resultClrType == typeof(void))
        {
            element = TypeSymbol.Void;
        }
        else
        {
            element = TypeSymbol.FromClrType(resultClrType);
        }

        return true;
    }

    private BoundExpression BindAwaitExpression(AwaitExpressionSyntax syntax)
    {
        var operand = BindExpression(syntax.Expression);

        if (function == null || (!function.IsAsync && !IsAsyncIteratorReturnType(function.Type)))
        {
            Diagnostics.ReportAwaitOutsideAsyncFunction(syntax.AwaitKeyword.Location);
            return new BoundErrorExpression(null);
        }

        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        if (!TryGetTaskElementType(operand.Type, out var element))
        {
            Diagnostics.ReportTypeIsNotAwaitable(syntax.Expression.Location, operand.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundAwaitExpression(null, operand, element);
    }

    private static TypeSymbol SubstituteType(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        if (type is TypeParameterSymbol tp)
        {
            return substitution.TryGetValue(tp, out var concrete) ? concrete : type;
        }

        if (type is NullableTypeSymbol n)
        {
            var inner = SubstituteType(n.UnderlyingType, substitution);
            return ReferenceEquals(inner, n.UnderlyingType) ? type : NullableTypeSymbol.Get(inner);
        }

        if (type is SliceTypeSymbol s)
        {
            var inner = SubstituteType(s.ElementType, substitution);
            return ReferenceEquals(inner, s.ElementType) ? type : SliceTypeSymbol.Get(inner);
        }

        if (type is ArrayTypeSymbol a)
        {
            var inner = SubstituteType(a.ElementType, substitution);
            return ReferenceEquals(inner, a.ElementType) ? type : ArrayTypeSymbol.Get(inner, a.Length);
        }

        if (type is FunctionTypeSymbol fn)
        {
            var changed = false;
            var builder = ImmutableArray.CreateBuilder<TypeSymbol>(fn.ParameterTypes.Length);
            foreach (var paramType in fn.ParameterTypes)
            {
                var substituted = SubstituteType(paramType, substitution);
                changed |= !ReferenceEquals(substituted, paramType);
                builder.Add(substituted);
            }

            var substitutedReturn = SubstituteType(fn.ReturnType, substitution);
            changed |= !ReferenceEquals(substitutedReturn, fn.ReturnType);
            return changed ? FunctionTypeSymbol.Get(builder.MoveToImmutable(), substitutedReturn) : type;
        }

        if (type is ImportedTypeSymbol it && it.HasTypeParameterArgument)
        {
            // #313: substitute a generic type parameterized by an in-scope type
            // parameter (e.g. `List[T]` with {T: int32} → `List<int32>`). When
            // every argument becomes concrete, reconstruct the real closed CLR
            // type so downstream member/index/conversion resolution sees the
            // substituted form; otherwise keep an erased constructed symbol.
            var newArgs = ImmutableArray.CreateBuilder<TypeSymbol>(it.TypeArguments.Length);
            var changed = false;
            var anyFree = false;
            foreach (var arg in it.TypeArguments)
            {
                var substituted = SubstituteType(arg, substitution);
                if (!ReferenceEquals(substituted, arg))
                {
                    changed = true;
                }

                if (TypeSymbol.ContainsTypeParameter(substituted))
                {
                    anyFree = true;
                }

                newArgs.Add(substituted);
            }

            if (!changed)
            {
                return type;
            }

            var substitutedArgs = newArgs.MoveToImmutable();
            if (!anyFree && it.OpenDefinition != null)
            {
                var clrArgs = new System.Type[substitutedArgs.Length];
                var allClr = true;
                for (var i = 0; i < substitutedArgs.Length; i++)
                {
                    var clr = substitutedArgs[i].ClrType;
                    if (clr == null)
                    {
                        allClr = false;
                        break;
                    }

                    clrArgs[i] = clr;
                }

                if (allClr)
                {
                    try
                    {
                        return TypeSymbol.FromClrType(it.OpenDefinition.MakeGenericType(clrArgs));
                    }
                    catch (System.ArgumentException)
                    {
                        // Fall through to the erased constructed form below.
                    }
                }
            }

            return ImportedTypeSymbol.GetConstructed(it.ClrType, it.OpenDefinition, substitutedArgs);
        }

        return type;
    }

    // Phase 4.2 / ADR-0020: returns true if `typeArgument` satisfies the constraint of a
    // type parameter. Both the enum constraint and the optional sealed-interface bound
    // must hold.
    private static bool SatisfiesConstraint(TypeSymbol typeArgument, TypeParameterSymbol tp)
    {
        if (tp.InterfaceConstraint != null)
        {
            if (!ImplementsInterface(typeArgument, tp.InterfaceConstraint))
            {
                return false;
            }
        }

        if (tp.Constraint == TypeParameterConstraint.Comparable && !IsComparable(typeArgument))
        {
            return false;
        }

        return true;
    }

    private static bool ImplementsInterface(TypeSymbol typeArgument, InterfaceSymbol iface)
    {
        if (typeArgument is StructSymbol s)
        {
            foreach (var implemented in s.Interfaces)
            {
                if (implemented == iface)
                {
                    return true;
                }
            }
        }

        if (typeArgument is InterfaceSymbol i && i == iface)
        {
            return true;
        }

        if (typeArgument is TypeParameterSymbol tp && tp.InterfaceConstraint == iface)
        {
            return true;
        }

        return false;
    }

    private static bool IsComparable(TypeSymbol type)
    {
        if (type == TypeSymbol.Int32 || type == TypeSymbol.String || type == TypeSymbol.Bool)
        {
            return true;
        }

        if (type is NullableTypeSymbol n)
        {
            return IsComparable(n.UnderlyingType);
        }

        if (type is StructSymbol s && s.IsData)
        {
            return true;
        }

        if (type is TypeParameterSymbol tp)
        {
            return tp.Constraint == TypeParameterConstraint.Comparable;
        }

        return false;
    }

    private static string DescribeConstraint(TypeParameterSymbol tp)
    {
        if (tp.InterfaceConstraint != null)
        {
            return tp.InterfaceConstraint.Name;
        }

        return tp.Constraint switch
        {
            TypeParameterConstraint.Any => "any",
            TypeParameterConstraint.Comparable => "comparable",
            _ => tp.Constraint.ToString().ToLowerInvariant(),
        };
    }

    private bool TryBindIntrinsicCall(CallExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;
        var name = syntax.Identifier.Text;
        switch (name)
        {
            case "len":
            case "cap":
            {
                if (syntax.Arguments.Count != 1)
                {
                    Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, name, 1, syntax.Arguments.Count);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var operand = BindExpression(syntax.Arguments[0]);
                if (operand.Type == TypeSymbol.Error)
                {
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var ok = operand.Type is ArrayTypeSymbol || operand.Type is SliceTypeSymbol
                    || (name == "len" && (operand.Type == TypeSymbol.String || operand.Type is MapTypeSymbol));
                if (!ok)
                {
                    Diagnostics.ReportIntrinsicArgumentType(syntax.Arguments[0].Location, name, operand.Type);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                result = name == "len"
                    ? new BoundLenExpression(syntax, operand)
                    : new BoundCapExpression(syntax, operand);
                return true;
            }

            case "append":
            {
                if (syntax.Arguments.Count != 2)
                {
                    Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, name, 2, syntax.Arguments.Count);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var slice = BindExpression(syntax.Arguments[0]);
                if (slice.Type == TypeSymbol.Error)
                {
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                if (slice.Type is not SliceTypeSymbol sliceType)
                {
                    Diagnostics.ReportIntrinsicArgumentType(syntax.Arguments[0].Location, name, slice.Type);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var element = conversions.BindConversion(syntax.Arguments[1], sliceType.ElementType);
                result = new BoundAppendExpression(syntax, slice, element, sliceType);
                return true;
            }

            case "delete":
            {
                // Phase 3.A.4: `delete(m, k)` removes key `k` from map `m`.
                if (syntax.Arguments.Count != 2)
                {
                    Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, name, 2, syntax.Arguments.Count);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var mapExpr = BindExpression(syntax.Arguments[0]);
                if (mapExpr.Type == TypeSymbol.Error)
                {
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                if (mapExpr.Type is not MapTypeSymbol mapType)
                {
                    Diagnostics.ReportIntrinsicArgumentType(syntax.Arguments[0].Location, name, mapExpr.Type);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var keyExpr = conversions.BindConversion(syntax.Arguments[1], mapType.KeyType);
                result = new BoundMapDeleteExpression(syntax, mapExpr, keyExpr);
                return true;
            }

            case "close":
            {
                // Phase 5.4 / ADR-0022: `close(ch)` marks the channel writer complete.
                if (syntax.Arguments.Count != 1)
                {
                    Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, name, 1, syntax.Arguments.Count);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                var chanExpr = BindExpression(syntax.Arguments[0]);
                if (chanExpr.Type == TypeSymbol.Error)
                {
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                if (chanExpr.Type is not ChannelTypeSymbol)
                {
                    Diagnostics.ReportCloseOperandIsNotChannel(syntax.Arguments[0].Location, chanExpr.Type);
                    result = new BoundErrorExpression(syntax);
                    return true;
                }

                result = new BoundChannelCloseExpression(syntax, chanExpr);
                return true;
            }

            default:
                return false;
        }
    }

    private bool TryBindClrConstructorCall(CallExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;
        var name = syntax.Identifier.Text;

        System.Type clrType = null;
        if (syntax.TypeArgumentList != null)
        {
            // `List[int]()`, `Dictionary[string, int]()`, etc. Resolve the open
            // generic via imports (mangled `Name`N`) and construct the closed
            // type via Type.MakeGenericType.
            if (!scope.TryLookupImportedGenericClass(name, syntax.TypeArgumentList.Arguments.Count, out var openType))
            {
                return false;
            }

            var clrArgs = new System.Type[syntax.TypeArgumentList.Arguments.Count];
            for (var i = 0; i < syntax.TypeArgumentList.Arguments.Count; i++)
            {
                var ta = BindTypeClause(syntax.TypeArgumentList.Arguments[i]);
                if (ta?.ClrType == null)
                {
                    return false;
                }

                // Project host CLR type arguments onto the resolver's reference
                // set so they share openType's load context (its
                // MetadataLoadContext when references are supplied via /r:),
                // which MakeGenericType requires.
                clrArgs[i] = scope.References.MapClrTypeToReferences(ta.ClrType);
            }

            try
            {
                clrType = openType.MakeGenericType(clrArgs);
            }
            catch (System.ArgumentException)
            {
                return false;
            }
        }
        else
        {
            if (!scope.TryLookupImportedClass(name, declaration: null, out var importedClass))
            {
                return false;
            }

            if (importedClass.ClassType.IsGenericTypeDefinition)
            {
                // User wrote `List(...)` without `[T]`; can't construct an open generic.
                return false;
            }

            clrType = importedClass.ClassType;
        }

        return TryBindClrConstructorFromType(clrType, syntax, out result);
    }

    /// <summary>
    /// Binds a constructor invocation against an already-resolved CLR
    /// <paramref name="clrType"/>. Shared by the simple-name constructor path
    /// (<see cref="TryBindClrConstructorCall"/>) and the fully-qualified path
    /// (<see cref="TryBindQualifiedClrConstructorCall"/>) so that imported-type
    /// construction resolves identically regardless of how the type name was
    /// written (issue #293).
    /// </summary>
    /// <param name="clrType">The closed CLR type to construct.</param>
    /// <param name="syntax">The call syntax carrying the arguments and location.</param>
    /// <param name="result">The bound constructor call on success.</param>
    /// <returns>Whether a constructor was resolved and bound.</returns>
    private bool TryBindClrConstructorFromType(System.Type clrType, CallExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;

        if (clrType.IsAbstract || clrType.IsInterface)
        {
            return false;
        }

        // Issue #343: pre-validate named-argument layout for CLR constructor calls.
        if (!overloads.TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames))
        {
            result = new BoundErrorExpression(syntax);
            return true;
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            boundArguments.Add(BindExpression(OverloadResolver.UnwrapNamedArgumentValue(syntax.Arguments[i])));
        }

        // Phase A (overload resolution): pick a constructor via the shared
        // "better function member" resolver. Ambiguity surfaces a hard
        // binder diagnostic and the call falls back to the surrounding
        // pipeline (which will diagnose a missing match).
        var ctors = ClrTypeUtilities.SafeGetConstructors(clrType, BindingFlags.Public | BindingFlags.Instance);
        var argTypes = new System.Type[boundArguments.Count];
        var argsAllTyped = true;
        for (var i = 0; i < boundArguments.Count; i++)
        {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) to flow through; overload
            // resolution now handles null source as compatible with reference
            // types and Nullable<T>.
            var t = GetEffectiveArgumentClrType(boundArguments[i].Type);
            if (t == null && boundArguments[i].Type != TypeSymbol.Null)
            {
                argsAllTyped = false;
                break;
            }

            argTypes[i] = t;
        }

        ConstructorInfo bestCtor = null;
        ImmutableArray<int> ctorMapping = default;
        bool ctorIsExpanded = false;
        if (argsAllTyped)
        {
            var resolution = OverloadResolution.Resolve(ctors, argTypes, interpolatedStringArgs: ComputeInterpolatedStringArgFlags(syntax.Arguments, boundArguments.Count), argumentNames: argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
            switch (resolution.Outcome)
            {
                case OverloadResolution.ResolutionOutcome.Resolved:
                    bestCtor = resolution.Best;
                    ctorMapping = resolution.ParameterMapping;
                    ctorIsExpanded = resolution.IsExpanded;
                    break;
                case OverloadResolution.ResolutionOutcome.Ambiguous:
                    Diagnostics.ReportAmbiguousOverload(syntax.Location, clrType.Name, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                    return false;
                default:
                    break;
            }
        }

        if (bestCtor == null)
        {
            // Issue #524: CLR value types always have an implicit zero-init
            // default "constructor" — at the IL level that's `initobj T`, not
            // a `newobj` against any `.ctor`. Reflection's
            // `Type.GetConstructors` does NOT surface this synthetic ctor, so
            // overload resolution fails for `T()` on a struct that declares
            // no explicit ctors. Lower the zero-argument case to
            // `BoundDefaultExpression(T)` so the emitter materializes
            // `ldloca/initobj/ldloc`. Reference types (and anything with no
            // declared parameterless ctor) still fall through to the generic
            // "no overload" diagnostic.
            if (syntax.Arguments.Count == 0
                && argumentNames.IsDefault
                && clrType.IsValueType
                && !clrType.IsEnum
                && !clrType.IsPrimitive
                && !clrType.ContainsGenericParameters)
            {
                result = new BoundDefaultExpression(syntax, TypeSymbol.FromClrType(clrType));
                return true;
            }

            // Issue #343: a CLR constructor call that mismatched on a name we
            // can show as "no such parameter" is more actionable than the
            // generic fallback diagnostic.
            if (!argumentNames.IsDefault
                && overloads.TryReportUnknownNamedArgumentForClrConstructor(clrType, syntax, argumentNames))
            {
                result = new BoundErrorExpression(syntax);
                return true;
            }

            return false;
        }

        var ctorParameters = bestCtor.GetParameters();
        var ctorRefKinds = ComputeArgumentRefKinds(ctorParameters);
        var ctorRawArgs = boundArguments.MoveToImmutable();
        var ctorExpandedArgs = ctorIsExpanded
            ? overloads.ExpandParamsArguments(ctorRawArgs, ctorParameters, syntax, parameterMapping: ctorMapping)
            : ctorRawArgs;

        // Issue #506 follow-up: when expanded form fires (with or without
        // named arguments), the expander emits the arguments already in
        // parameter order with optional slots filled — downstream reorderers
        // therefore consume an identity mapping.
        var ctorDownstreamMapping = ctorIsExpanded ? default : ctorMapping;
        var ctorRebound = RebindFormattableInterpolationArguments(ctorExpandedArgs, syntax.Arguments, ctorParameters, ctorDownstreamMapping);
        var ctorHandlerArgs = ApplyInterpolatedStringHandlers(ctorParameters, ctorRebound, receiver: null, syntax.Location, ctorDownstreamMapping);

        // Issue #506 follow-up: fixed-arity CLR ctor overloads expecting an
        // `object` parameter from a value-type argument require a boxing
        // conversion in IL; route through BindClrParameterConversions so the
        // emitter sees a BoundConversionExpression and emits `box <T>`.
        var ctorConvertedArgs = conversions.BindClrParameterConversions(ctorHandlerArgs, ctorParameters, syntax, ctorDownstreamMapping);
        var ctorArgs = OverloadResolver.BuildOrderedCallArguments(ctorConvertedArgs, ctorDownstreamMapping, ctorParameters);
        if (!ctorRefKinds.IsDefault)
        {
            overloads.ValidateRefArguments(ctorArgs, ctorRefKinds, clrType.Name, syntax.Location);
        }

        result = new BoundClrConstructorCallExpression(
            syntax,
            clrType,
            bestCtor,
            ctorArgs,
            TypeSymbol.FromClrType(clrType),
            ctorRefKinds);
        return true;
    }

    /// <summary>
    /// Binds a fully-qualified imported-type constructor written in expression
    /// position, e.g. <c>System.Text.StringBuilder()</c> or
    /// <c>System.Collections.Generic.List[int]()</c>. Such an expression parses
    /// as an accessor chain whose terminal segment is the constructor call, so
    /// it never reaches <see cref="TryBindClrConstructorCall"/> (which only sees
    /// simple-name calls). This walks the dotted name, resolves the closed CLR
    /// type via the active references/imports, and reuses the shared
    /// constructor-binding core (issue #293).
    /// </summary>
    /// <param name="syntax">The accessor expression to bind.</param>
    /// <param name="result">The bound constructor call on success.</param>
    /// <returns>Whether the accessor was a fully-qualified constructor call that bound successfully.</returns>
    private bool TryBindQualifiedClrConstructorCall(AccessorExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;

        if (syntax.IsNullConditional)
        {
            return false;
        }

        // Flatten the accessor chain into the leading namespace/type segments
        // and the terminal constructor call. Anything that isn't a pure
        // dotted-name chain ending in a call is not a qualified constructor.
        var segments = new List<string>();
        ExpressionSyntax current = syntax;
        CallExpressionSyntax terminalCall = null;
        while (true)
        {
            if (current is AccessorExpressionSyntax accessor)
            {
                if (accessor.IsNullConditional || !(accessor.LeftPart is NameExpressionSyntax leftName))
                {
                    return false;
                }

                segments.Add(leftName.IdentifierToken.Text);
                current = accessor.RightPart;
                continue;
            }

            if (current is CallExpressionSyntax call)
            {
                terminalCall = call;
                break;
            }

            // A bare trailing name (`System.Text.StringBuilder` with no call)
            // is not a constructor invocation.
            return false;
        }

        if (terminalCall == null || terminalCall.Identifier.IsMissing)
        {
            return false;
        }

        var typeSimpleName = terminalCall.Identifier.Text;
        var namespacePrefix = string.Join(".", segments);

        if (!TryResolveQualifiedClrType(namespacePrefix, typeSimpleName, terminalCall, out var clrType))
        {
            return false;
        }

        return TryBindClrConstructorFromType(clrType, terminalCall, out result);
    }

    /// <summary>
    /// Resolves a closed CLR type from a fully-qualified dotted name written in
    /// source. Tries the name as written, the name with the leading segment
    /// expanded from a matching import alias/path, and the name prefixed by each
    /// active import target. Generic type arguments on <paramref name="terminalCall"/>
    /// are honoured by resolving the mangled open generic and closing it.
    /// </summary>
    /// <param name="namespacePrefix">The dotted segments preceding the type name (may be empty).</param>
    /// <param name="typeSimpleName">The simple type name (the constructor call identifier).</param>
    /// <param name="terminalCall">The terminal call, used for generic arity/arguments.</param>
    /// <param name="clrType">The resolved closed CLR type on success.</param>
    /// <returns>Whether a type was resolved.</returns>
    private bool TryResolveQualifiedClrType(string namespacePrefix, string typeSimpleName, CallExpressionSyntax terminalCall, out System.Type clrType)
    {
        clrType = null;

        var arity = terminalCall.TypeArgumentList?.Arguments.Count ?? 0;

        // Build the candidate dotted prefixes (everything before the simple
        // type name), most specific first.
        var prefixCandidates = new List<string>();
        if (!string.IsNullOrEmpty(namespacePrefix))
        {
            prefixCandidates.Add(namespacePrefix);
        }

        // If the leading segment is an import alias/path, expand it to the
        // import target (`import t = System.Text` then `t.StringBuilder()`).
        var firstSegment = namespacePrefix.Contains('.', System.StringComparison.Ordinal)
            ? namespacePrefix.Substring(0, namespacePrefix.IndexOf('.', System.StringComparison.Ordinal))
            : namespacePrefix;
        if (!string.IsNullOrEmpty(firstSegment) && scope.TryLookupImport(firstSegment, out var matchedImport))
        {
            var rest = namespacePrefix.Length > firstSegment.Length
                ? namespacePrefix.Substring(firstSegment.Length + 1)
                : string.Empty;
            var expanded = string.IsNullOrEmpty(rest) ? matchedImport.Target : matchedImport.Target + "." + rest;
            prefixCandidates.Insert(0, expanded);
        }

        // Also try the name relative to each active import target, mirroring the
        // simple-name lookup in BoundScope.TryLookupImportedClass.
        foreach (var import in scope.GetDeclaredImports())
        {
            var prefixed = string.IsNullOrEmpty(namespacePrefix) ? import.Target : import.Target + "." + namespacePrefix;
            prefixCandidates.Add(prefixed);
        }

        foreach (var prefix in prefixCandidates)
        {
            if (arity > 0)
            {
                var mangled = prefix + "." + typeSimpleName + "`" + arity;
                if (scope.References.TryResolveType(mangled, out var openType))
                {
                    var clrArgs = new System.Type[arity];
                    var argsResolved = true;
                    for (var i = 0; i < arity; i++)
                    {
                        var ta = BindTypeClause(terminalCall.TypeArgumentList.Arguments[i]);
                        if (ta?.ClrType == null)
                        {
                            argsResolved = false;
                            break;
                        }

                        // Type arguments resolve to gsc-host CLR types (e.g.
                        // primitives map to host typeof(...)), but openType may
                        // come from the resolver's isolated MetadataLoadContext.
                        // MakeGenericType requires every argument to share the
                        // open generic's load context, so project each argument
                        // onto the resolver's reference set first.
                        clrArgs[i] = scope.References.MapClrTypeToReferences(ta.ClrType);
                    }

                    if (!argsResolved)
                    {
                        continue;
                    }

                    try
                    {
                        clrType = openType.MakeGenericType(clrArgs);
                        return true;
                    }
                    catch (System.ArgumentException)
                    {
                        continue;
                    }
                }
            }
            else
            {
                var fullName = prefix + "." + typeSimpleName;
                if (scope.References.TryResolveType(fullName, out var resolved) && !resolved.IsGenericTypeDefinition)
                {
                    clrType = resolved;
                    return true;
                }
            }
        }

        return false;
    }

    private BoundExpression BindAccessorExpression(AccessorExpressionSyntax syntax)
    {
        // Phase 3.C.3b / ADR-0001: null-conditional access `lhs?.rhs`.
        // Evaluate the receiver once, capture it into a synthetic local,
        // then bind the rest of the access against the capture so the
        // subtree can be evaluated against the non-nil value without a
        // second evaluation of the receiver expression.
        if (syntax.IsNullConditional)
        {
            return BindNullConditionalAccessExpression(syntax);
        }

        // Issue #293: a fully-qualified imported-type constructor
        // (`System.Text.StringBuilder()`, `System.Collections.Generic.List[int]()`)
        // parses as an accessor chain whose terminal segment is the call, so it
        // never reaches the simple-name constructor path in BindCallExpression.
        // Resolve it the same way here so construction works identically whether
        // written as a simple name or a fully-qualified path, at top level and
        // inside function/method bodies alike.
        if (TryBindQualifiedClrConstructorCall(syntax, out var qualifiedCtorCall))
        {
            return qualifiedCtorCall;
        }

        // Determine what the left side of the accessor is: either an imported
        // class (for static member access) or a value-producing expression (for
        // instance member access). Then apply the right side, which may itself
        // be a chain of accessors (e.g. Guid.NewGuid().ToString()).
        var leftPart = syntax.LeftPart;
        var rightPart = syntax.RightPart;
        BoundExpression receiver = null;
        ImportedClassSymbol classSymbol = null;
        EnumSymbol enumSymbol = null;
        StructSymbol userStructSymbol = null;

        if (leftPart is NameExpressionSyntax leftName)
        {
            var name = leftName.IdentifierToken.Text;
            if (scope.TryLookupSymbol(name) is VariableSymbol variable)
            {
                if (variable is ImplicitFieldVariableSymbol implicitField)
                {
                    // Bare field name inside a method: rebind as `this.field`
                    // so chained access (`Field.Sub`) emits a load of the
                    // backing field through the `this` receiver.
                    // Issue #186 / #175: implicit field as accessor receiver
                    // fires GS0204 if the field carries `@Obsolete`.
                    ReportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitField.Field,
                        $"{implicitField.StructType.Name}.{implicitField.Field.Name}");

                    // Issue #208: apply any [MemberNotNull] narrowing so that
                    // chained access like `_name.Length` after a [MemberNotNull]
                    // call is accepted without a nil-guard.
                    receiver = new BoundFieldAccessExpression(
                        null,
                        new BoundVariableExpression(null, implicitField.Receiver),
                        implicitField.StructType,
                        implicitField.Field,
                        TryGetNarrowedType(implicitField));
                }
                else if (variable is ImplicitStaticFieldVariableSymbol implicitStaticField)
                {
                    // Issue #261: bare static field name as accessor receiver
                    // inside a shared method body.
                    ReportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitStaticField.Field,
                        $"{implicitStaticField.StructType.Name}.{implicitStaticField.Field.Name}");

                    receiver = new BoundFieldAccessExpression(
                        null,
                        receiver: null,
                        implicitStaticField.StructType,
                        implicitStaticField.Field);
                }
                else if (variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp)
                {
                    // ADR-0053: bare static property name as accessor receiver
                    // (e.g., `StaticProp.Sub` inside a method body of the
                    // enclosing type).
                    ReportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitStaticProp.Property,
                        $"{implicitStaticProp.StructType.Name}.{implicitStaticProp.Property.Name}");

                    if (!implicitStaticProp.Property.HasGetter)
                    {
                        Diagnostics.ReportCannotAssign(leftName.IdentifierToken.Location, implicitStaticProp.Property.Name);
                        return new BoundErrorExpression(null);
                    }

                    receiver = new BoundPropertyAccessExpression(
                        null,
                        receiver: null,
                        implicitStaticProp.StructType,
                        implicitStaticProp.Property);
                }
                else
                {
                    receiver = new BoundVariableExpression(null, variable, TryGetNarrowedType(variable));
                }
            }
            else if (scope.TryLookupImport(name, out var matchedImport)
                && TryBindImportAccessor(matchedImport, ref rightPart, out var typeFromImport))
            {
                classSymbol = typeFromImport;
            }
            else if (scope.TryLookupImportedClass(name, leftName, out var importedClass))
            {
                classSymbol = importedClass;
            }
            else if (scope.TryLookupTypeAlias(name, out var typeAlias))
            {
                if (typeAlias is EnumSymbol foundEnum)
                {
                    enumSymbol = foundEnum;
                }
                else if (typeAlias is StructSymbol foundStruct)
                {
                    userStructSymbol = foundStruct;
                }
                else
                {
                    Diagnostics.ReportUnableToFindType(leftName.Location, name);
                    return new BoundErrorExpression(null);
                }
            }
            else
            {
                Diagnostics.ReportUnableToFindType(leftName.Location, name);
                return new BoundErrorExpression(null);
            }
        }
        else
        {
            receiver = BindExpression(leftPart);
        }

        if (enumSymbol != null)
        {
            return BindEnumAccessorStep(enumSymbol, rightPart);
        }

        if (userStructSymbol != null)
        {
            return BindUserTypeStaticAccessorStep(userStructSymbol, rightPart);
        }

        return BindAccessorStep(receiver, classSymbol, rightPart);
    }

    private BoundExpression BindNullConditionalAccessExpression(AccessorExpressionSyntax syntax)
    {
        var receiver = BindExpression(syntax.LeftPart);
        if (receiver is BoundErrorExpression)
        {
            return receiver;
        }

        return BindNullConditionalAccessExpressionCore(receiver, syntax.RightPart);
    }

    // Issue #507 follow-up: shared core for binding a `?.<rhs>` access against
    // an already-bound receiver expression. Used by BindNullConditionalAccessExpression
    // (when the receiver is the left side of the outermost accessor) and by the
    // BindAccessorStep nested-accessor case (when a `?.` accessor appears as the
    // right side of an outer `.` chain — e.g. `o.InnerObj?.Map`, which
    // ParseNameOrCallExpression folds into `AccessorExpression(o, ., AccessorExpression(InnerObj, ?., Map))`).
    private BoundExpression BindNullConditionalAccessExpressionCore(BoundExpression receiver, ExpressionSyntax rightPart)
    {
        var receiverType = receiver.Type;
        TypeSymbol underlying;
        if (receiverType is NullableTypeSymbol nullable)
        {
            underlying = nullable.UnderlyingType;
        }
        else if (receiverType == TypeSymbol.Null)
        {
            // `nil?.x` is statically nil.
            return new BoundLiteralExpression(null, null);
        }
        else
        {
            // Non-nullable receiver: `?.` collapses to `.`, but we still
            // produce a nullable result type for syntactic consistency.
            underlying = receiverType;
        }

        // Create a synthetic capture local. Name is not user-visible; we
        // include a leading `$` so it cannot collide with user identifiers.
        var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);

        // Bind the access using the capture as the receiver. We push a temp
        // scope so the capture is in scope for any nested name lookup that
        // happens during access binding (defensive — current accessor paths
        // don't look up the receiver by name).
        scope = new BoundScope(scope);
        scope.TryDeclareVariable(capture);

        var captureRef = new BoundVariableExpression(null, capture);
        var whenNotNull = BindAccessorStep(captureRef, null, rightPart);

        scope = scope.Parent;

        var resultType = whenNotNull.Type is NullableTypeSymbol ? whenNotNull.Type : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);

        // P2-7 / Issue #421: when the access result is a value type, the
        // bound result type is `Nullable<T>` but the not-null branch pushes
        // a raw `T` and the nil branch would push `null`. The emitter needs
        // a typed temp slot to materialize `default(Nullable<T>)` for the
        // nil branch (initobj) and to host the wrapped value for the
        // not-null branch (newobj `Nullable<T>::.ctor(!0)`). We allocate
        // that synthetic slot here so the emit pre-pass can give it a
        // local index alongside the capture local.
        LocalVariableSymbol resultSlot = null;
        if (whenNotNull.Type is not NullableTypeSymbol
            && whenNotNull.Type?.ClrType is { IsValueType: true })
        {
            var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
            resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
        }

        return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, resultType, resultSlot);
    }

    private bool TryBindImportAccessor(ImportSymbol import, ref ExpressionSyntax rightPart, out ImportedClassSymbol importedClass)
    {
        // Handle `<importName>.<TypeName>(.<more>)*` where <importName> is either an
        // alias or the import's path. The next segment of the chain names the type;
        // we resolve `<import.Target>.<TypeName>` and consume that segment.
        importedClass = null;

        NameExpressionSyntax typeNameSyntax;
        ExpressionSyntax remainder;

        switch (rightPart)
        {
            case AccessorExpressionSyntax nested when nested.LeftPart is NameExpressionSyntax leftName:
                typeNameSyntax = leftName;
                remainder = nested.RightPart;
                break;

            case NameExpressionSyntax ne:
                typeNameSyntax = ne;
                remainder = ne;
                break;

            default:
                return false;
        }

        var fullTypeName = import.Target + "." + typeNameSyntax.IdentifierToken.Text;
        if (!scope.References.TryResolveType(fullTypeName, out var type))
        {
            return false;
        }

        importedClass = new ImportedClassSymbol(type, typeNameSyntax);
        rightPart = remainder;
        return true;
    }

    private BoundExpression BindEnumAccessorStep(EnumSymbol enumSymbol, ExpressionSyntax rightPart)
    {
        switch (rightPart)
        {
            case AccessorExpressionSyntax nested:
                var head = BindEnumAccessorStep(enumSymbol, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case NameExpressionSyntax ne:
                var memberName = ne.IdentifierToken.Text;
                if (enumSymbol.TryGetMember(memberName, out var member))
                {
                    // Issue #188 / #175: every read of an `@Obsolete` enum
                    // member surfaces GS0204 at the member-identifier
                    // location (e.g. `Color.Red`).
                    ReportObsoleteUseIfApplicable(ne.Location, member, $"{enumSymbol.Name}.{member.Name}");
                    return new BoundLiteralExpression(null, member.Value, enumSymbol);
                }

                Diagnostics.ReportUndefinedEnumMember(ne.Location, memberName, enumSymbol.Name);
                return new BoundErrorExpression(null);

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// Handles <c>TypeName.member</c> and <c>TypeName.method(args)</c> accessor
    /// resolution for user-defined struct/class static members (ADR-0053).
    /// </summary>
    private BoundExpression BindUserTypeStaticAccessorStep(StructSymbol structSym, ExpressionSyntax rightPart)
    {
        switch (rightPart)
        {
            case AccessorExpressionSyntax nested:
                var head = BindUserTypeStaticAccessorStep(structSym, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case CallExpressionSyntax ce:
                return BindUserTypeStaticCall(structSym, ce);

            case NameExpressionSyntax ne:
                return BindUserTypeStaticMemberAccess(structSym, ne);

            default:
                return new BoundErrorExpression(null);
        }
    }

    private BoundExpression BindUserTypeStaticMemberAccess(StructSymbol structSym, NameExpressionSyntax ne)
    {
        var memberName = ne.IdentifierToken.Text;

        if (structSym.TryGetStaticField(memberName, out var field))
        {
            return new BoundFieldAccessExpression(null, receiver: null, structSym, field);
        }

        foreach (var prop in structSym.StaticProperties)
        {
            if (prop.Name == memberName)
            {
                return new BoundPropertyAccessExpression(null, receiver: null, structSym, prop);
            }
        }

        Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
        return new BoundErrorExpression(null);
    }

    private BoundExpression BindUserTypeStaticCall(StructSymbol structSym, CallExpressionSyntax ce)
    {
        var methodName = ce.Identifier.Text;

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var argument in ce.Arguments)
        {
            if (argument is RefArgumentExpressionSyntax refArg)
            {
                boundArguments.Add(BindRefArgumentExpression(refArg, parameter: null));
            }
            else
            {
                boundArguments.Add(BindExpression(argument));
            }
        }

        var arguments = boundArguments.ToImmutable();

        if (structSym.TryGetStaticMethod(methodName, out var method))
        {
            if (arguments.Length != method.Parameters.Length)
            {
                Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, method.Parameters.Length, arguments.Length);
                return new BoundErrorExpression(null);
            }

            // Issue #312 / ADR-0020: resolve a generic static method's own type
            // arguments from an explicit `[T1, T2]` list at the call site or by
            // left-to-right inference from argument types.
            Dictionary<TypeParameterSymbol, TypeSymbol> substitution = null;
            if (method.IsGeneric)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
                if (ce.TypeArgumentList != null)
                {
                    var explicitArgs = ce.TypeArgumentList.Arguments;
                    if (explicitArgs.Count != method.TypeParameters.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(ce.TypeArgumentList.Location, method.Name, method.TypeParameters.Length, explicitArgs.Count);
                        return new BoundErrorExpression(null);
                    }

                    for (var i = 0; i < explicitArgs.Count; i++)
                    {
                        var ta = BindTypeClause(explicitArgs[i]);
                        if (ta == null)
                        {
                            return new BoundErrorExpression(null);
                        }

                        substitution[method.TypeParameters[i]] = ta;
                    }
                }
                else
                {
                    for (var i = 0; i < arguments.Length; i++)
                    {
                        InferTypeArguments(method.Parameters[i].Type, arguments[i].Type, substitution);
                    }

                    foreach (var tp in method.TypeParameters)
                    {
                        if (!substitution.ContainsKey(tp))
                        {
                            Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, method.Name, tp.Name);
                            return new BoundErrorExpression(null);
                        }
                    }
                }

                var constraintLocation = ce.TypeArgumentList != null
                    ? ce.TypeArgumentList.Location
                    : ce.Identifier.Location;
                foreach (var tp in method.TypeParameters)
                {
                    var typeArg = substitution[tp];
                    if (!SatisfiesConstraint(typeArg, tp))
                    {
                        Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, DescribeConstraint(tp));
                        return new BoundErrorExpression(null);
                    }
                }
            }

            var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
            for (var i = 0; i < arguments.Length; i++)
            {
                var paramType = method.Parameters[i].Type;
                if (paramType is TypeParameterSymbol)
                {
                    convertedArgs.Add(arguments[i]);
                    continue;
                }

                if (substitution != null
                    && paramType is FunctionTypeSymbol openFunctionParameter
                    && LambdaBinder.TryGetFunctionLiteral(arguments[i], out var functionLiteralArgument))
                {
                    convertedArgs.Add(lambdas.CreateErasedFunctionLiteralAdapter(functionLiteralArgument, openFunctionParameter));
                    continue;
                }

                var expectedType = substitution != null ? SubstituteType(paramType, substitution) : paramType;
                convertedArgs.Add(conversions.BindCallArgumentWithRefKind(ce.Arguments[i].Location, arguments[i], expectedType, method.Parameters[i]));
            }

            if (substitution != null)
            {
                var substitutedReturn = SubstituteType(method.Type, substitution);
                if (method.IsAsync && !IsAsyncIteratorReturnType(method.Type))
                {
                    substitutedReturn = lambdas.WrapAsTask(substitutedReturn);
                    return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), substitutedReturn);
                }

                if (!ReferenceEquals(substitutedReturn, method.Type))
                {
                    return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), substitutedReturn);
                }
            }

            if (method.IsAsync && !IsAsyncIteratorReturnType(method.Type))
            {
                var asyncReturn = lambdas.WrapAsTask(method.Type);
                return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), asyncReturn);
            }

            return new BoundCallExpression(null, method, convertedArgs.ToImmutable());
        }

        Diagnostics.ReportUnableToFindMember(ce.Location, methodName);
        return new BoundErrorExpression(null);
    }

    private BoundExpression BindAccessorStep(BoundExpression receiver, ImportedClassSymbol classSymbol, ExpressionSyntax rightPart)
    {
        switch (rightPart)
        {
            case AccessorExpressionSyntax nested:
                var head = BindAccessorStep(receiver, classSymbol, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                // Issue #507 follow-up: ParseNameOrCallExpression folds the
                // right-hand side of an accessor through ParsePostfixChain, so
                // `a.b?.c` parses as `AccessorExpression(a, ., AccessorExpression(b, ?., c))`.
                // The nested accessor's `?.` token must be honored here, or the
                // read/write degenerates into a plain `.c` against `b`'s nullable
                // type and reports "Cannot find member c".
                if (nested.IsNullConditional)
                {
                    return BindNullConditionalAccessExpressionCore(head, nested.RightPart);
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case CallExpressionSyntax ce:
                return BindAccessorCall(receiver, classSymbol, ce);

            // Issue #507 follow-up: support indexer reads through a member chain
            // (`obj.Member[k]`, `obj.A.B[k]`, `obj?.Member[k]`). ParsePostfixChain
            // folds a trailing `[...]` into the right-hand side of the most
            // recent `.`, so the indexer arrives here as the rightPart of an
            // AccessorExpression. We bind the indexer's target through the
            // accessor chain so we get the correct member-rooted bound receiver,
            // then route the index resolution through the shared helper.
            case IndexExpressionSyntax ix:
                var indexTarget = BindAccessorStep(receiver, classSymbol, ix.Target);
                if (indexTarget is BoundErrorExpression)
                {
                    return indexTarget;
                }

                return BindIndexAgainstTarget(indexTarget, ix.Index, ix.Target.Location);

            case NameExpressionSyntax ne:
                if (ne.IdentifierToken.IsMissing)
                {
                    // Incomplete member access such as `x.` with no member name yet.
                    // The parser already reported the missing identifier; binding a
                    // null member name would throw (e.g. Type.GetProperty(null)), so
                    // bail out gracefully. This keeps completion / semantic tokens
                    // working while the user is mid-typing.
                    return new BoundErrorExpression(null);
                }

                if (classSymbol != null)
                {
                    var foundMember = classSymbol.TryLookupMember(ne.IdentifierToken.Text, ne, out var staticMember);
                    if (!foundMember)
                    {
                        // Issue #337: a static member name that resolves to a
                        // method (not a field/property) is a method group. In a
                        // delegate-conversion context it materializes as a
                        // delegate over the selected overload; the conversion
                        // classifier decides which overload (if any) applies.
                        if (TryBindClrMethodGroup(receiver: null, classSymbol.ClassType, wantStatic: true, ne.IdentifierToken.Text, out var staticGroup))
                        {
                            return staticGroup;
                        }

                        Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                        return new BoundErrorExpression(null);
                    }

                    // Stream B: static field/property read on imported type.
                    // `Receiver == null` flags the access as static. Literal
                    // (const) fields aren't real runtime fields, so we inline
                    // their constant value rather than emit `ldsfld`.
                    if (staticMember is FieldInfo litField && litField.IsLiteral)
                    {
                        return new BoundLiteralExpression(null, litField.GetRawConstantValue(), TypeSymbol.FromClrType(litField.FieldType));
                    }

                    var staticType = staticMember switch
                    {
                        PropertyInfo sp => TypeSymbol.FromClrType(sp.PropertyType),
                        FieldInfo sf => TypeSymbol.FromClrType(sf.FieldType),
                        _ => TypeSymbol.Error,
                    };
                    return new BoundClrPropertyAccessExpression(null, null, staticMember, staticType);
                }
                else if (receiver != null && receiver.Type is StructSymbol structSym)
                {
                    // Walk base chain to find the field.
                    for (var c = structSym; c != null; c = c.BaseClass)
                    {
                        if (c.TryGetField(ne.IdentifierToken.Text, out var field))
                        {
                            // Issue #186 / #175: dotted field read fires
                            // GS0204 if the field carries `@Obsolete`.
                            ReportObsoleteUseIfApplicable(ne.IdentifierToken.Location, field, $"{c.Name}.{field.Name}");
                            return new BoundFieldAccessExpression(null, receiver, c, field);
                        }
                    }

                    // ADR-0051: check properties before reporting "unable to find member".
                    if (MemberLookup.TryGetPropertyIncludingInherited(structSym, ne.IdentifierToken.Text, out var prop))
                    {
                        if (!prop.HasGetter)
                        {
                            Diagnostics.ReportCannotAssign(ne.Location, ne.IdentifierToken.Text);
                            return new BoundErrorExpression(null);
                        }

                        return new BoundPropertyAccessExpression(null, receiver, structSym, prop);
                    }

                    // Issue #296: a GSharp class inheriting an imported CLR base
                    // exposes the base's instance properties/fields. Fall back to
                    // CLR member lookup on the imported base type.
                    if (structSym.ImportedBaseType?.ClrType is System.Type inheritedBaseClr)
                    {
                        var memberName = ne.IdentifierToken.Text;
                        var clrProp = ClrTypeUtilities.SafeGetProperty(inheritedBaseClr, memberName, BindingFlags.Public | BindingFlags.Instance);
                        if (clrProp != null && clrProp.GetIndexParameters().Length == 0 && clrProp.CanRead)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrProp, TypeSymbol.FromClrType(clrProp.PropertyType));
                        }

                        var clrFld = ClrTypeUtilities.SafeGetField(inheritedBaseClr, memberName, BindingFlags.Public | BindingFlags.Instance);
                        if (clrFld != null)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrFld, TypeSymbol.FromClrType(clrFld.FieldType));
                        }
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }
                else if (receiver != null && receiver.Type is TupleTypeSymbol tupleSym)
                {
                    // Phase 4.5: tuple element access via Item1..ItemN.
                    var memberName = ne.IdentifierToken.Text;
                    if (memberName.StartsWith("Item", System.StringComparison.Ordinal)
                        && int.TryParse(memberName.Substring(4), out var oneBased)
                        && oneBased >= 1 && oneBased <= tupleSym.Arity)
                    {
                        return new BoundTupleElementAccessExpression(null, receiver, tupleSym, oneBased - 1);
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null && receiver.Type is NullableTypeSymbol nullableSym
                    && nullableSym.UnderlyingType?.ClrType is { IsValueType: true } nullableInnerClr
                    && this.memberLookup.TryGetNullableConstructedType(nullableInnerClr, out var nullableClr))
                {
                    // Issue #517: a value-type `T?` lowers to `System.Nullable<T>`
                    // at the CLR layer (see `EncodeTypeSymbol`). Resolve `.Value`,
                    // `.HasValue`, etc. against that constructed generic so the
                    // BCL instance API surfaces the same way it does for any
                    // other CLR struct. NRT receivers (reference-type underlying)
                    // have no `Nullable<T>` projection and continue to fall
                    // through to the existing GS0158 path below.
                    var nullableMemberName = ne.IdentifierToken.Text;
                    var nullableProp = ClrTypeUtilities.SafeGetProperty(nullableClr, nullableMemberName, BindingFlags.Public | BindingFlags.Instance);
                    if (nullableProp != null && nullableProp.GetIndexParameters().Length == 0 && nullableProp.CanRead)
                    {
                        var nullablePropType = ClrNullability.GetPropertyTypeSymbol(nullableProp);
                        return new BoundClrPropertyAccessExpression(null, receiver, nullableProp, nullablePropType);
                    }

                    if (TryBindClrMethodGroup(receiver, nullableClr, wantStatic: false, nullableMemberName, out var nullableGroup))
                    {
                        return nullableGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, nullableMemberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null && receiver.Type is not NullableTypeSymbol && receiver.Type.ClrType != null)
                {
                    // Phase 4 exit: read a public instance property or field on
                    // a CLR receiver (e.g. `lst.Count`, `sb.Length`,
                    // `kvp.Key`). Static members are reached through
                    // ImportedClassSymbol; this path covers instances. Nullable
                    // receivers must be narrowed or use `?.` before this path.
                    var clrReceiverType = receiver.Type.ClrType;
                    var memberName = ne.IdentifierToken.Text;

                    // Issue #529: use interface-aware lookup so that members
                    // declared on a base interface (e.g. IReadOnlyCollection<T>.Count
                    // surfaced through IReadOnlyList<T>) are found.
                    var prop = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(clrReceiverType, memberName, BindingFlags.Public | BindingFlags.Instance);
                    if (prop != null && prop.GetIndexParameters().Length == 0 && prop.CanRead)
                    {
                        // Issue #504 follow-up: properties with NRT
                        // annotations (e.g. `DirectoryInfo.Parent` is
                        // `DirectoryInfo?`) must surface as
                        // NullableTypeSymbol so callers can compare to
                        // `nil` without GS0129. ByRef-returning properties
                        // are rare on CLR types and stay on the existing
                        // MapClrMemberType path, which preserves the
                        // ByRefTypeSymbol wrapper.
                        var propType = prop.PropertyType.IsByRef
                            ? MapClrMemberType(prop.PropertyType)
                            : ClrNullability.GetPropertyTypeSymbol(prop);
                        return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrPropertyAccessExpression(null, receiver, prop, propType));
                    }

                    var fld = ClrTypeUtilities.SafeGetFieldIncludingInterfaces(clrReceiverType, memberName, BindingFlags.Public | BindingFlags.Instance);
                    if (fld != null)
                    {
                        return new BoundClrPropertyAccessExpression(null, receiver, fld, ClrNullability.GetFieldTypeSymbol(fld));
                    }

                    // Issue #337: an instance member name that resolves to a
                    // method (not a field/property) is a method group bound to
                    // this receiver. In a delegate-conversion context it captures
                    // the receiver as the delegate target over the selected
                    // overload.
                    if (TryBindClrMethodGroup(receiver, clrReceiverType, wantStatic: false, memberName, out var instanceGroup))
                    {
                        return instanceGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }
                else
                {
                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }

                return new BoundErrorExpression(null);

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// Issue #311: resolves the explicit <c>[T1, T2]</c> type-argument list on a
    /// generic-method call site into CLR types projected onto the reference load
    /// context, ready for <see cref="System.Reflection.MethodInfo.MakeGenericMethod"/>.
    /// Mirrors the generic-construction path so primitives and constructed
    /// generics resolve against the target framework's reference assemblies.
    /// </summary>
    /// <param name="typeArgumentList">The call site's explicit type-argument list, or <c>null</c>.</param>
    /// <param name="explicitTypeArgs">On success, the resolved (mapped) CLR type arguments; <c>null</c> when the list is absent.</param>
    /// <param name="typeArgSymbols">
    /// Issue #320: on success, the resolved type-argument <see cref="TypeSymbol"/>s
    /// in source order; default when the list is absent. These carry user-defined
    /// types (which have no reference-context CLR type and are closed with an
    /// <see cref="object"/> placeholder in <paramref name="explicitTypeArgs"/>) so
    /// later stages can recover and emit the real type argument.
    /// </param>
    /// <returns>
    /// <see langword="true"/> when there is no list (no explicit type args) or
    /// every argument resolved; <see langword="false"/> when a type argument
    /// could not be resolved.
    /// </returns>
    private bool TryResolveExplicitMethodTypeArgs(TypeArgumentListSyntax typeArgumentList, out System.Type[] explicitTypeArgs, out ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        explicitTypeArgs = null;
        typeArgSymbols = default;
        if (typeArgumentList == null)
        {
            return true;
        }

        var resolved = new System.Type[typeArgumentList.Arguments.Count];
        var symbols = ImmutableArray.CreateBuilder<TypeSymbol>(typeArgumentList.Arguments.Count);
        for (var i = 0; i < typeArgumentList.Arguments.Count; i++)
        {
            var ta = BindTypeClause(typeArgumentList.Arguments[i]);
            if (ta == null)
            {
                return false;
            }

            symbols.Add(ta);

            if (ta.ClrType != null)
            {
                // BCL / imported type argument. Project onto the resolver's
                // reference set so it shares the open generic method's load
                // context, exactly as the generic-construction path does before
                // MakeGenericType / MakeGenericMethod.
                // Issue #530: use ResolveClrTypeForGenericArg so that
                // `int32?` resolves to `Nullable<int>` (not bare `int`).
                resolved[i] = ResolveClrTypeForGenericArg(ta) ?? scope.References.MapClrTypeToReferences(ta.ClrType);
            }
            else
            {
                // Issue #320: a user-defined type (or an in-scope type parameter)
                // has no reference-context CLR type, so it cannot be handed to
                // MakeGenericMethod directly. Close the open method with a
                // reference-context System.Object placeholder so resolution and
                // applicability still run; the real type-argument symbol is
                // preserved in typeArgSymbols and re-emitted as its own TypeDef
                // token in the generic method specification.
                resolved[i] = scope.References.GetCoreType("System.Object");
            }
        }

        explicitTypeArgs = resolved;
        typeArgSymbols = symbols.MoveToImmutable();
        return true;
    }

    /// <summary>
    /// Issue #320: computes a return-type override for an imported generic method
    /// closed over explicit type arguments. When the method's open return type is
    /// exactly one of its method type parameters, the real return type is the
    /// corresponding explicit type-argument symbol (recovering a user-defined type
    /// that was closed with an <see cref="object"/> placeholder). Returns
    /// <see langword="null"/> when no override is needed, so callers keep their
    /// existing return-type derivation.
    /// </summary>
    /// <param name="closed">The closed generic method selected by overload resolution.</param>
    /// <param name="typeArgSymbols">The explicit type-argument symbols, or default.</param>
    /// <returns>The override return type symbol, or <see langword="null"/>.</returns>
    private static TypeSymbol ResolveImportedGenericReturnType(System.Reflection.MethodInfo closed, ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        if (!typeArgSymbols.IsDefaultOrEmpty
            && OverloadResolution.TryGetGenericMethodParameterReturnPosition(closed, out var position)
            && position >= 0
            && position < typeArgSymbols.Length)
        {
            return typeArgSymbols[position];
        }

        return null;
    }

    private BoundExpression BindAccessorCall(BoundExpression receiver, ImportedClassSymbol classSymbol, CallExpressionSyntax ce)
    {
        var methodName = ce.Identifier.Text;
        var hasNamedArguments = ce.Arguments.Any(argument => argument is NamedArgumentExpressionSyntax);
        if (classSymbol == null && methodName == "copy" && (hasNamedArguments || (receiver?.Type is StructSymbol copyStruct && copyStruct.IsData)))
        {
            if (TryGetCopyOverrides(ce, out var overrides))
            {
                return LowerCopyOrWith(receiver, overrides, ce.Identifier.Location);
            }

            Diagnostics.ReportNamedArgumentOnlyValidForCopy(ce.Location);
            return new BoundErrorExpression(null);
        }

        // Issue #343: validate named-argument layout (positional precedes named,
        // no duplicate names). Errors are reported by the helper so the call
        // short-circuits to a bound error here.
        if (!overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var argument in ce.Arguments)
        {
            var inner = OverloadResolver.UnwrapNamedArgumentValue(argument);
            if (inner is RefArgumentExpressionSyntax refArg)
            {
                boundArguments.Add(BindRefArgumentExpression(refArg, parameter: null));
            }
            else
            {
                boundArguments.Add(BindExpression(inner));
            }
        }

        var arguments = boundArguments.ToImmutable();

        // Issue #311: resolve an explicit `[T1, T2]` type-argument list (e.g.
        // `Array.Empty[string]()`) into mapped CLR types up front so every
        // generic-method dispatch path below can close the candidate.
        if (!TryResolveExplicitMethodTypeArgs(ce.TypeArgumentList, out var explicitTypeArgs, out var typeArgSymbols))
        {
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        if (classSymbol != null)
        {
            if (classSymbol.TryLookupFunction(methodName, ce, arguments, out var staticFn, out var staticMapping, out var staticAmbiguous, out var staticAmbiguousMethods, out var staticIsExpanded, explicitTypeArgs, typeArgSymbols, scope.References.MapClrTypeToReferences, argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames))
            {
                var staticParameters = staticFn.Method.GetParameters();
                var staticExpandedArgs = staticIsExpanded
                    ? overloads.ExpandParamsArguments(arguments, staticParameters, ce, parameterMapping: staticMapping)
                    : arguments;
                var staticDownstreamMapping = staticIsExpanded ? default : staticMapping;
                var staticRebound = RebindFormattableInterpolationArguments(staticExpandedArgs, ce.Arguments, staticParameters, staticDownstreamMapping);
                var staticHandlerArgs = ApplyInterpolatedStringHandlers(staticParameters, staticRebound, receiver: null, ce.Location, staticDownstreamMapping);

                // Issue #506 follow-up: ensure value-type → object boxing fires
                // for fixed-arity CLR static calls (e.g. `String.Format("{0}", 42)`
                // selecting the fixed `(string, object)` overload).
                var staticConvertedArgs = conversions.BindClrParameterConversions(staticHandlerArgs, staticParameters, ce, staticDownstreamMapping);
                var staticArguments = OverloadResolver.BuildOrderedCallArguments(staticConvertedArgs, staticDownstreamMapping, staticParameters);
                var refKinds = ComputeArgumentRefKinds(staticParameters);
                overloads.ValidateRefArguments(staticArguments, refKinds, methodName, ce.Location);
                return new BoundImportedCallExpression(null, staticFn, staticArguments, refKinds, typeArgSymbols);
            }

            if (staticAmbiguous)
            {
                // Issue #505: surface the competing candidate signatures so the
                // caller can pick a disambiguation (typically an explicit
                // type-argument list).
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, staticAmbiguousMethods.Length, staticAmbiguousMethods.Select(OverloadResolution.FormatMethodSignature));
                return new BoundErrorExpression(null);
            }

            // Issue #343: a named-argument call that resolves to no candidate
            // is most actionably explained by the first unknown name (if any),
            // since the missing parameter is the prevailing cause.
            if (!argumentNames.IsDefault && overloads.TryReportUnknownNamedArgumentForClr(classSymbol.ClassType, methodName, BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public, ce, argumentNames))
            {
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        if (receiver == null || receiver.Type?.ClrType == null)
        {
            // ADR-0059 / issue #255: a value of a user-declared named delegate
            // type supports member-style invocation `del.Invoke(args)` (same as
            // any CLR delegate). Lower to a BoundIndirectCallExpression whose
            // function shape mirrors the delegate's declared signature; the
            // emitter recognises a DelegateTypeSymbol target and dispatches
            // through the delegate's runtime-implemented Invoke MethodDef.
            if (receiver != null && receiver.Type is DelegateTypeSymbol delRecv && string.Equals(methodName, "Invoke", System.StringComparison.Ordinal))
            {
                return BindNamedDelegateInvokeCall(receiver, delRecv, arguments, ce);
            }

            // Phase 3.B.4: dispatch to a user-defined interface method when
            // the static receiver type is an interface.
            if (receiver != null && receiver.Type is InterfaceSymbol ifaceRecv)
            {
                var ifaceOverloads = ifaceRecv.GetMethods(methodName);
                if (ifaceOverloads.Length > 0)
                {
                    var ifaceMethod = overloads.SelectInstanceOverloadOrReport(ifaceOverloads, arguments, ce, methodName, argumentNames);
                    if (ifaceMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, ifaceMethod, arguments, ce, argumentNames);
                }
            }

            // Phase 4.2b / ADR-0020: dispatch through a type parameter's
            // sealed-interface constraint, just as if the receiver were
            // typed as the interface itself.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpRecv && tpRecv.InterfaceConstraint != null)
            {
                var tpOverloads = tpRecv.InterfaceConstraint.GetMethods(methodName);
                if (tpOverloads.Length > 0)
                {
                    var tpIfaceMethod = overloads.SelectInstanceOverloadOrReport(tpOverloads, arguments, ce, methodName, argumentNames);
                    if (tpIfaceMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, tpIfaceMethod, arguments, ce, argumentNames);
                }
            }

            // Phase 3.B.3 sub-step 2b: dispatch to a user-defined class method
            // if receiver is a user struct symbol.
            if (receiver != null && receiver.Type is StructSymbol userClass)
            {
                var userOverloads = userClass.GetMethodsIncludingInherited(methodName);
                if (userOverloads.Length > 0)
                {
                    var userMethod = overloads.SelectInstanceOverloadOrReport(userOverloads, arguments, ce, methodName, argumentNames);
                    if (userMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, userMethod, arguments, ce, argumentNames);
                }

                // Issue #527: fall back to a delegate/function-typed field on
                // the user struct/class. This is the same delegate-as-callable
                // dispatch used for the imported-CLR path below; here the
                // receiver's ClrType is null (the user type has not yet been
                // emitted) so we have to handle the symbol-only shape too.
                if (TryBindUserStructDelegateFieldInvocation(receiver, userClass, methodName, arguments, ce, out var userDelegateFieldCall))
                {
                    return userDelegateFieldCall;
                }
            }

            // Phase 3.B.6 / ADR-0019: extension function fallback for
            // user-type receivers (struct/class/interface).
            if (receiver != null && scope.TryLookupExtensionFunction(receiver.Type, methodName, out var userExtFn))
            {
                return overloads.BindExtensionFunctionCall(receiver, userExtFn, arguments, ce, argumentNames);
            }

            // Issue #296: a GSharp class inheriting an imported CLR base class
            // exposes the base's instance members. After user-defined and
            // extension lookups fail, resolve the call against the imported
            // base CLR type so inherited members are callable on the derived
            // GSharp instance. Inherited instance members take precedence over
            // imported extension methods.
            if (receiver != null && receiver.Type is StructSymbol inheritedDerived
                && inheritedDerived.ImportedBaseType?.ClrType is System.Type inheritedBaseClr
                && TryBindInheritedClrInstanceCall(receiver, inheritedBaseClr, methodName, arguments, ce, out var inheritedCall, explicitTypeArgs, typeArgSymbols, argumentNames))
            {
                return inheritedCall;
            }

            // Issue #294: imported [Extension] method dispatched with instance
            // (receiver) syntax, when the receiver carries a CLR type even
            // though its symbol is a user/interface shape.
            if (receiver != null && TryBindImportedExtensionCall(receiver, methodName, arguments, ce, out var userPathExt, explicitTypeArgs, typeArgSymbols, argumentNames))
            {
                return userPathExt;
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        // Prefer a user-defined class method when the receiver is a user
        // class symbol that has one with this name. (BCL lookup is the
        // fallback for imported CLR types.)
        if (receiver.Type is StructSymbol userClassPriority)
        {
            var priorityOverloads = userClassPriority.GetMethodsIncludingInherited(methodName);
            if (priorityOverloads.Length > 0)
            {
                var userMethodPriority = overloads.SelectInstanceOverloadOrReport(priorityOverloads, arguments, ce, methodName, argumentNames);
                if (userMethodPriority == null)
                {
                    return new BoundErrorExpression(null);
                }

                return overloads.BindUserInstanceCall(receiver, userMethodPriority, arguments, ce, argumentNames);
            }

            // Issue #527: a G#-defined struct/class field whose type is a
            // function (or named delegate) is invokable through the same
            // call syntax as a bare function-typed variable. Lower to a load
            // of the field value followed by an indirect call. Field lookup
            // walks the inheritance chain (a class can inherit a delegate
            // field from a base class).
            if (TryBindUserStructDelegateFieldInvocation(receiver, userClassPriority, methodName, arguments, ce, out var userDelegateCall))
            {
                return userDelegateCall;
            }
        }

        // Issue #517: a value-type `T?` lowers to `System.Nullable<T>` at the
        // CLR layer; `receiver.Type.ClrType` returns the underlying T's CLR
        // type (so the binder can share lifting/conversion logic), but
        // instance-method lookup (e.g. `GetValueOrDefault`, `Equals`,
        // `ToString`) must go through the constructed `Nullable<T>` type that
        // actually carries those members.
        var clrType = receiver.Type is NullableTypeSymbol nullableRecv
            && nullableRecv.UnderlyingType?.ClrType is { IsValueType: true } nullableInnerVt
            && this.memberLookup.TryGetNullableConstructedType(nullableInnerVt, out var nullableConstructed)
            ? nullableConstructed
            : receiver.Type.ClrType;

        // Issue #529: use interface-aware method enumeration so that
        // methods declared on a base interface (e.g.
        // IEnumerable<T>.GetEnumerator() surfaced through
        // IReadOnlyList<T>) are found.
        var candidates = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(clrType, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
            .Where(m => m.Name == methodName)
            .ToList();
        if (candidates.Count > 0)
        {
            var argTypes = new System.Type[arguments.Length];
            var argsAllTyped = true;
            for (var i = 0; i < arguments.Length; i++)
            {
                // Issue #530: use GetEffectiveArgumentClrType so that a
                // nullable value type argument (e.g. `int32?`) is matched
                // as `Nullable<T>` in overload resolution.
                // Issue #533: allow null (nil literal) through.
                var t = GetEffectiveArgumentClrType(arguments[i].Type);
                if (t == null && arguments[i].Type != TypeSymbol.Null)
                {
                    argsAllTyped = false;
                    break;
                }

                argTypes[i] = t;
            }

            if (argsAllTyped)
            {
                var resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences, ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length), argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
                switch (resolution.Outcome)
                {
                    case OverloadResolution.ResolutionOutcome.Resolved:
                        var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols) ?? MapClrMemberType(resolution.Best.ReturnType);
                        var instParameters = resolution.Best.GetParameters();
                        var instMapping = resolution.ParameterMapping;
                        var instExpandedArgs = resolution.IsExpanded
                            ? overloads.ExpandParamsArguments(arguments, instParameters, ce, parameterMapping: instMapping)
                            : arguments;
                        var instDownstreamMapping = resolution.IsExpanded ? default : instMapping;
                        var instRebound = RebindFormattableInterpolationArguments(instExpandedArgs, ce.Arguments, instParameters, instDownstreamMapping);
                        var instHandlerArgs = ApplyInterpolatedStringHandlers(instParameters, instRebound, receiver, ce.Location, instDownstreamMapping);
                        var instDelegateArgs = RebindFunctionLiteralDelegateArguments(instHandlerArgs, instParameters, instDownstreamMapping);
                        var instConvertedArgs = conversions.BindClrParameterConversions(instDelegateArgs, instParameters, ce, instDownstreamMapping);
                        var instArguments = OverloadResolver.BuildOrderedCallArguments(instConvertedArgs, instDownstreamMapping, instParameters);
                        var instRefKinds = ComputeArgumentRefKinds(instParameters);
                        overloads.ValidateRefArguments(instArguments, instRefKinds, methodName, ce.Location);
                        return ConversionClassifier.AutoDereferenceRefReturn(new BoundImportedInstanceCallExpression(null, receiver, resolution.Best, returnType, instArguments, instRefKinds, typeArgSymbols));
                    case OverloadResolution.ResolutionOutcome.Ambiguous:
                        Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                        return new BoundErrorExpression(null);
                    default:
                        break;
                }
            }
        }

        // Issue #527: a public field or property whose type is a CLR delegate
        // (e.g. `public Func<string> OnAsk;`) is invokable through the same
        // call syntax used on the variable itself — `bag.OnAsk()`. Method
        // lookup above only consulted methods named `OnAsk`, so the delegate
        // member would otherwise miss. Lower to a load of the delegate value
        // followed by an `Invoke(args)` dispatch (mirrors the bare-delegate
        // call path in BindCallExpression at #325). This must come before the
        // extension-function fallbacks so an in-scope extension method does
        // not shadow a real delegate-typed member on the type.
        if (receiver != null
            && TryBindClrDelegateMemberInvocation(receiver, clrType, methodName, arguments, ce, argumentNames, out var delegateMemberCall))
        {
            return delegateMemberCall;
        }

        // Phase 3.B.6 / ADR-0019: extension function fallback. After all
        // instance/static lookups fail, try matching by (receiverType, name).
        if (receiver != null && scope.TryLookupExtensionFunction(receiver.Type, methodName, out var extFn))
        {
            return overloads.BindExtensionFunctionCall(receiver, extFn, arguments, ce, argumentNames);
        }

        // Issue #294: BCL/library [Extension] method dispatched with instance
        // (receiver) syntax. After instance members and user extension
        // functions fail, fall back to imported static [Extension] methods
        // whose first parameter is compatible with the receiver type.
        if (receiver != null && TryBindImportedExtensionCall(receiver, methodName, arguments, ce, out var importedExt, explicitTypeArgs, typeArgSymbols, argumentNames))
        {
            return importedExt;
        }

        // Issue #343: if all CLR-instance lookups missed and the call uses
        // named arguments, point at the first unknown parameter name (if any)
        // for a more actionable diagnostic than "unable to find function".
        if (!argumentNames.IsDefault && receiver?.Type?.ClrType is System.Type recvClr
            && overloads.TryReportUnknownNamedArgumentForClr(recvClr, methodName, BindingFlags.Instance | BindingFlags.Public, ce, argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        return new BoundErrorExpression(null);
    }

    /// <summary>
    /// Issue #527 (G#-defined struct/class arm): when a member-style call
    /// <c>receiver.Member(args)</c> does not match a method on the user
    /// struct/class, fall back to a field whose type is a function value or
    /// named delegate. Lowers to a load of the field followed by a
    /// <see cref="BoundIndirectCallExpression"/> through the function shape.
    /// Returns <see langword="true"/> when a callable field matched (the
    /// resulting expression may be a <see cref="BoundErrorExpression"/> if
    /// arity is wrong).
    /// </summary>
    private bool TryBindUserStructDelegateFieldInvocation(
        BoundExpression receiver,
        StructSymbol receiverStruct,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result)
    {
        result = null;

        // Walk the base chain so an inherited delegate field on a base class
        // is invokable on a derived instance.
        FieldSymbol matchedField = null;
        StructSymbol declaringType = null;
        for (var c = receiverStruct; c != null; c = c.BaseClass)
        {
            if (c.TryGetField(methodName, out var f))
            {
                matchedField = f;
                declaringType = c;
                break;
            }
        }

        if (matchedField == null)
        {
            return false;
        }

        FunctionTypeSymbol functionType;
        if (matchedField.Type is FunctionTypeSymbol fts)
        {
            functionType = fts;
        }
        else if (matchedField.Type is DelegateTypeSymbol nds)
        {
            functionType = nds.EquivalentFunctionType;
        }
        else if (matchedField.Type?.ClrType is System.Type fieldClrType
            && ClrTypeUtilities.IsDelegateType(fieldClrType)
            && MemberLookup.TryGetDelegateFunctionType(fieldClrType, out var clrFn))
        {
            functionType = clrFn;
        }
        else
        {
            return false;
        }

        if (arguments.Length != functionType.ParameterTypes.Length)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, functionType.ParameterTypes.Length, arguments.Length);
            result = new BoundErrorExpression(null);
            return true;
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            convertedArgs.Add(conversions.BindConversion(ce.Arguments[i].Location, arguments[i], functionType.ParameterTypes[i]));
        }

        var fieldLoad = new BoundFieldAccessExpression(null, receiver, declaringType, matchedField);
        result = new BoundIndirectCallExpression(null, fieldLoad, functionType, convertedArgs.MoveToImmutable());
        return true;
    }

    /// <summary>
    /// Issue #527: when an accessor-style call <c>receiver.Member(args)</c>
    /// matches no method on the CLR receiver type, fall back to a public
    /// field or property of the same name whose type is a CLR delegate.
    /// Lowers to a load of the delegate value (<c>ldfld</c> / property getter)
    /// followed by an <c>Invoke(args)</c> call. Returns <see langword="true"/>
    /// when a delegate-typed member matched and the call was bound (the
    /// resulting expression may be a <see cref="BoundErrorExpression"/> if
    /// argument resolution failed).
    /// </summary>
    private bool TryBindClrDelegateMemberInvocation(
        BoundExpression receiver,
        System.Type clrType,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;
        if (clrType == null)
        {
            return false;
        }

        // Prefer a property of the right name over a field — the same
        // precedence used by the read path in BindAccessorStep (properties
        // first, fields fallback). Indexer properties (those with parameters)
        // are not member-style invocable, so skip them.
        System.Reflection.MemberInfo member = ClrTypeUtilities.SafeGetProperty(clrType, methodName, BindingFlags.Public | BindingFlags.Instance);
        if (member is System.Reflection.PropertyInfo prop && (prop.GetIndexParameters().Length != 0 || !prop.CanRead))
        {
            member = null;
        }

        member ??= ClrTypeUtilities.SafeGetField(clrType, methodName, BindingFlags.Public | BindingFlags.Instance);
        if (member == null)
        {
            return false;
        }

        System.Type memberClrType = member switch
        {
            System.Reflection.PropertyInfo p => p.PropertyType,
            System.Reflection.FieldInfo f => f.FieldType,
            _ => null,
        };
        if (memberClrType == null || !ClrTypeUtilities.IsDelegateType(memberClrType))
        {
            return false;
        }

        TypeSymbol memberTypeSymbol = member switch
        {
            System.Reflection.PropertyInfo p2 => ClrNullability.GetPropertyTypeSymbol(p2),
            System.Reflection.FieldInfo f2 => ClrNullability.GetFieldTypeSymbol(f2),
            _ => TypeSymbol.FromClrType(memberClrType),
        };

        // The delegate value load — `ldfld` for a field, `call get_X` for a
        // property. The shared BoundClrPropertyAccessExpression node carries
        // either MemberInfo shape, and EmitClrPropertyAccess already handles
        // both (including the value-type-receiver `ldloca` step we need for
        // a CLR struct field).
        var delegateLoad = new BoundClrPropertyAccessExpression(null, receiver, member, memberTypeSymbol);

        // Strip nullable annotation when dispatching through Invoke — the
        // delegate value is loaded as-is from the field; the call would
        // dereference null at runtime if the member is unassigned. This
        // matches CLR semantics for `del()` on a null `Func<T>`.
        var underlyingDelegateClr = memberClrType;

        // Reuse the same Invoke-overload-resolution path that the bare
        // delegate-variable call uses at #325 (BindCallExpression), so
        // generic delegate arguments, named arguments, and ref/in/out are
        // all handled uniformly.
        if (TryBindInheritedClrInstanceCall(delegateLoad, underlyingDelegateClr, "Invoke", arguments, ce, out var invokeCall, argumentNames: argumentNames))
        {
            result = invokeCall;
            return true;
        }

        // No applicable Invoke overload — most likely an argument-count or
        // type mismatch. Report against the member name (not "Invoke") so the
        // diagnostic points to what the user wrote.
        var invoke = memberClrType.GetMethod("Invoke");
        var expectedArity = invoke?.GetParameters().Length ?? 0;
        if (arguments.Length != expectedArity)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, expectedArity, arguments.Length);
        }
        else
        {
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        }

        result = new BoundErrorExpression(null);
        return true;
    }

    /// <summary>
    /// Issue #296: resolves an instance method call against an imported CLR
    /// base class for a GSharp class receiver that inherits it. Uses the same
    /// overload resolution as direct imported-instance calls; <c>GetMethods</c>
    /// on the base type already includes members inherited up the CLR chain.
    /// Returns <c>true</c> with a bound call when a unique match is found.
    /// </summary>
    private bool TryBindInheritedClrInstanceCall(
        BoundExpression receiver,
        System.Type importedBaseClr,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result,
        System.Type[] explicitTypeArgs = null,
        ImmutableArray<TypeSymbol> typeArgSymbols = default,
        ImmutableArray<string> argumentNames = default)
    {
        result = null;

        var candidates = importedBaseClr
            .GetMethods(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
            .Where(m => m.Name == methodName)
            .ToList();
        if (candidates.Count == 0)
        {
            return false;
        }

        var argTypes = new System.Type[arguments.Length];
        for (var i = 0; i < arguments.Length; i++)
        {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            var t = GetEffectiveArgumentClrType(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                return false;
            }

            argTypes[i] = t;
        }

        var resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences, argumentNames: argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
        switch (resolution.Outcome)
        {
            case OverloadResolution.ResolutionOutcome.Resolved:
                var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols) ?? TypeSymbol.FromClrType(resolution.Best.ReturnType);
                var inheritedParameters = resolution.Best.GetParameters();
                var inheritedMapping = resolution.ParameterMapping;
                var inheritedExpandedArgs = resolution.IsExpanded
                    ? overloads.ExpandParamsArguments(arguments, inheritedParameters, ce, parameterMapping: inheritedMapping)
                    : arguments;
                var inheritedDownstreamMapping = resolution.IsExpanded ? default : inheritedMapping;
                var inheritedHandlerArgs = ApplyInterpolatedStringHandlers(inheritedParameters, inheritedExpandedArgs, receiver, ce.Location, inheritedDownstreamMapping);
                var inheritedDelegateArgs = RebindFunctionLiteralDelegateArguments(inheritedHandlerArgs, inheritedParameters, inheritedDownstreamMapping);
                var inheritedConvertedArgs = conversions.BindClrParameterConversions(inheritedDelegateArgs, inheritedParameters, ce, inheritedDownstreamMapping);
                var inheritedArguments = OverloadResolver.BuildOrderedCallArguments(inheritedConvertedArgs, inheritedDownstreamMapping, inheritedParameters);
                var refKinds = ComputeArgumentRefKinds(inheritedParameters);
                overloads.ValidateRefArguments(inheritedArguments, refKinds, methodName, ce.Location);
                result = new BoundImportedInstanceCallExpression(null, receiver, resolution.Best, returnType, inheritedArguments, refKinds, typeArgSymbols);
                return true;
            case OverloadResolution.ResolutionOutcome.Ambiguous:
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                result = new BoundErrorExpression(null);
                return true;
            default:
                // Issue #343: if the failure is plausibly due to an unknown
                // named-argument target, surface that as the diagnostic.
                if (!argumentNames.IsDefault
                    && overloads.TryReportUnknownNamedArgumentForClr(importedBaseClr, methodName, BindingFlags.Instance | BindingFlags.Public, ce, argumentNames))
                {
                    result = new BoundErrorExpression(null);
                    return true;
                }

                return false;
        }
    }

    /// <summary>
    /// ADR-0059 / issue #255: lowers a <c>delegateValue.Invoke(args)</c>
    /// call against a value of <see cref="DelegateTypeSymbol"/> into a
    /// <see cref="BoundIndirectCallExpression"/> whose function shape is the
    /// delegate's equivalent <see cref="FunctionTypeSymbol"/>. The emitter
    /// recognises a DelegateTypeSymbol target and routes the call through
    /// the delegate's runtime-implemented Invoke MethodDef.
    /// </summary>
    private BoundExpression BindNamedDelegateInvokeCall(BoundExpression receiver, DelegateTypeSymbol delegateSym, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce)
    {
        if (arguments.Length != delegateSym.Parameters.Length)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, delegateSym.Name, delegateSym.Parameters.Length, arguments.Length);
            return new BoundErrorExpression(null);
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            convertedArgs.Add(conversions.BindConversion(ce.Arguments[i].Location, arguments[i], delegateSym.Parameters[i].Type));
        }

        return new BoundIndirectCallExpression(null, receiver, delegateSym.EquivalentFunctionType, convertedArgs.MoveToImmutable());
    }

    /// <summary>
    /// Issue #294: resolves a call written with instance ("receiver") syntax
    /// against an imported CLR static method marked with
    /// <c>[System.Runtime.CompilerServices.ExtensionAttribute]</c> whose first
    /// parameter is compatible with the receiver's type. This makes BCL/library
    /// extension methods (LINQ <c>Where</c>/<c>Select</c>/<c>ToList</c>, the
    /// ASP.NET Core minimal-API/middleware surface, etc.) callable as
    /// <c>receiver.Method(args)</c> rather than only statically as
    /// <c>DeclaringClass.Method(receiver, args)</c>.
    /// </summary>
    /// <param name="receiver">The bound receiver expression.</param>
    /// <param name="methodName">The method name at the call site.</param>
    /// <param name="arguments">The bound user arguments (excluding the receiver).</param>
    /// <param name="ce">The originating call expression.</param>
    /// <param name="result">The bound call when resolution succeeds (or a bound error on ambiguity).</param>
    /// <param name="explicitTypeArgs">Issue #311: resolved explicit type arguments from a <c>[T1, T2]</c> list, or <c>null</c> for inference.</param>
    /// <param name="typeArgSymbols">Issue #320: explicit type-argument symbols in source order (carrying user-defined types), or default.</param>
    /// <param name="argumentNames">Issue #343: per-source-argument names parallel to <paramref name="arguments"/> (entries are <see langword="null"/> for positional); default when the call is purely positional.</param>
    /// <returns>True when an imported extension method was matched (success or ambiguity); false to let the caller report GS0159.</returns>
    private bool TryBindImportedExtensionCall(BoundExpression receiver, string methodName, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, out BoundExpression result, System.Type[] explicitTypeArgs = null, ImmutableArray<TypeSymbol> typeArgSymbols = default, ImmutableArray<string> argumentNames = default)
    {
        result = null;

        var receiverClrType = receiver?.Type?.ClrType;
        if (receiverClrType == null)
        {
            return false;
        }

        // Build the argument-type vector as the extension method sees it: the
        // receiver becomes the first ("this") parameter, followed by the user
        // arguments. Every argument must carry a concrete CLR type so overload
        // resolution (including generic inference) can run.
        var argTypes = new Type[arguments.Length + 1];
        argTypes[0] = receiverClrType;
        for (var i = 0; i < arguments.Length; i++)
        {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            var t = GetEffectiveArgumentClrType(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                return false;
            }

            argTypes[i + 1] = t;
        }

        // Issue #343: extension methods are dispatched as `Class.Method(receiver, userArgs...)`,
        // so prepend a null slot to user-supplied argument names so positions
        // align with the method's parameter list (where index 0 is `this`).
        IReadOnlyList<string> extensionArgumentNames = null;
        if (!argumentNames.IsDefault)
        {
            var withReceiver = new string[arguments.Length + 1];
            for (var i = 0; i < arguments.Length; i++)
            {
                withReceiver[i + 1] = argumentNames[i];
            }

            extensionArgumentNames = withReceiver;
        }

        var candidates = this.memberLookup.CollectImportedExtensionMethods(methodName);
        if (candidates.Count == 0)
        {
            return false;
        }

        // OverloadResolution.Resolve infers type arguments for open generic
        // method definitions (e.g. Where<TSource>(IEnumerable<TSource>,
        // Func<TSource,bool>)) from the receiver and argument types. Issue #311:
        // when the call site supplied explicit type arguments (e.g.
        // services.AddSingleton[IService, Service]()), those are used to close
        // the generic method instead of inference.
        var resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences, argumentNames: extensionArgumentNames);
        switch (resolution.Outcome)
        {
            case OverloadResolution.ResolutionOutcome.Resolved:
                break;
            case OverloadResolution.ResolutionOutcome.Ambiguous:
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                result = new BoundErrorExpression(null);
                return true;
            default:
                return false;
        }

        var best = resolution.Best;
        var declaringType = best.DeclaringType;
        if (declaringType == null)
        {
            return false;
        }

        var importedClass = new ImportedClassSymbol(declaringType, ce);
        var returnOverride = ResolveImportedGenericReturnType(best, typeArgSymbols);
        var function = new ImportedFunctionSymbol(methodName, importedClass, best, ce, returnOverride);

        var allArguments = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length + 1);
        allArguments.Add(receiver);
        allArguments.AddRange(arguments);
        var bound = allArguments.MoveToImmutable();

        // Issue #506: when overload resolution selected the expanded form of a
        // `params T[]` extension method (e.g. `MyEnumerable.Concat(this src,
        // params string[] tail)` called with positional tail args), pack the
        // trailing positional arguments into a synthesised slice/array first.
        // The receiver occupies parameter slot 0; the params slot is always
        // the last parameter, so it never collides with the receiver. Named
        // arguments against an expanded-form extension are funnelled through
        // an offset mapping so the receiver position lines up with bound[0].
        var parameters = best.GetParameters();
        if (resolution.IsExpanded)
        {
            ImmutableArray<int> expandedMapping = default;
            if (!resolution.ParameterMapping.IsDefault)
            {
                var offset = ImmutableArray.CreateBuilder<int>(bound.Length);
                offset.Add(0);
                for (var i = 0; i < resolution.ParameterMapping.Length; i++)
                {
                    offset.Add(resolution.ParameterMapping[i]);
                }

                expandedMapping = offset.MoveToImmutable();
            }

            bound = overloads.ExpandParamsArguments(bound, parameters, ce, receiverArgCount: 1, parameterMapping: expandedMapping);
        }

        var downstreamMapping = resolution.IsExpanded ? default : resolution.ParameterMapping;

        // Issue #506 follow-up: route through BindClrParameterConversions so
        // value-type → object boxing fires for fixed-arity imported extension
        // calls too. The receiver occupies arg slot 0 (and is already typed
        // correctly via the extension dispatch).
        bound = conversions.BindClrParameterConversions(bound, parameters, ce, downstreamMapping, receiverArgCount: 1);

        // Issue #327 / #343: re-order arguments into parameter positions when
        // named arguments were used; otherwise fall through to the existing
        // trailing-optional fill.
        bound = OverloadResolver.BuildOrderedCallArguments(bound, downstreamMapping, parameters);

        var refKinds = ComputeArgumentRefKinds(parameters);
        overloads.ValidateRefArguments(bound, refKinds, methodName, ce.Location);
        result = new BoundImportedCallExpression(null, function, bound, refKinds, typeArgSymbols);
        return true;
    }

    private BoundExpression BindArrayCreationExpression(ArrayCreationExpressionSyntax syntax)
    {
        var elementType = LookupType(syntax.ElementTypeIdentifier.Text);
        if (elementType == null)
        {
            Diagnostics.ReportUndefinedType(syntax.ElementTypeIdentifier.Location, syntax.ElementTypeIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        var elements = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Elements.Count);
        foreach (var elementSyntax in syntax.Elements)
        {
            elements.Add(conversions.BindConversion(elementSyntax, elementType));
        }

        if (syntax.LengthToken == null)
        {
            return new BoundArrayCreationExpression(null, SliceTypeSymbol.Get(elementType), elements.ToImmutable());
        }

        if (!int.TryParse(syntax.LengthToken.Text, out var length) || length < 0)
        {
            Diagnostics.ReportInvalidArrayLength(syntax.LengthToken.Location, syntax.LengthToken.Text);
            return new BoundErrorExpression(null);
        }

        if (syntax.Elements.Count != length)
        {
            Diagnostics.ReportArrayLiteralLengthMismatch(syntax.Location, length, syntax.Elements.Count);
        }

        return new BoundArrayCreationExpression(null, ArrayTypeSymbol.Get(elementType, length), elements.ToImmutable());
    }

    private BoundExpression BindMapCreationExpression(MapCreationExpressionSyntax syntax)
    {
        // Phase 3.A.4: bind `map[K]V{k1: v1, k2: v2, …}`.
        var mapType = BindTypeClause(syntax.TypeClause);
        if (mapType == null)
        {
            return new BoundErrorExpression(null);
        }

        if (mapType is not MapTypeSymbol mts)
        {
            // Defensive — the parser only produces a map type clause here.
            Diagnostics.ReportUndefinedType(syntax.TypeClause.Location, mapType.Name);
            return new BoundErrorExpression(null);
        }

        var entries = ImmutableArray.CreateBuilder<BoundMapEntry>(syntax.Entries.Count);
        foreach (var entrySyntax in syntax.Entries)
        {
            var key = conversions.BindConversion(entrySyntax.Key, mts.KeyType);
            var value = conversions.BindConversion(entrySyntax.Value, mts.ValueType);
            entries.Add(new BoundMapEntry(key, value));
        }

        return new BoundMapLiteralExpression(null, mts, entries.ToImmutable());
    }

    private BoundExpression BindIndexExpression(IndexExpressionSyntax syntax)
    {
        var target = BindExpression(syntax.Target);
        return BindIndexAgainstTarget(target, syntax.Index, syntax.Target.Location);
    }

    // Issue #507 follow-up: the read-side counterpart to BindIndexedAssignmentToVariable.
    // Routes a bound target + index syntax through map / array / CLR-indexer
    // resolution and returns the bound index read. Extracted from
    // BindIndexExpression so the BindAccessorStep arm that handles
    // `receiver.Member[k]` (where the parser folds `[...]` into the right side
    // of the trailing `.`) can produce the same bound shape without re-running
    // the accessor chain.
    private BoundExpression BindIndexAgainstTarget(BoundExpression target, ExpressionSyntax indexSyntax, TextLocation targetLocation)
    {
        // Phase 3.A.4: map indexing `m[k]` — key bound to K, result type V.
        // The Go convention "zero value if missing" applies at evaluation;
        // the bound representation reuses BoundIndexExpression with the
        // element type set to V.
        if (target.Type is MapTypeSymbol mapType)
        {
            var key = conversions.BindConversion(indexSyntax, mapType.KeyType);
            return new BoundIndexExpression(null, target, key, mapType.ValueType);
        }

        var element = GetIndexElementType(target.Type);
        if (element != null)
        {
            var index = conversions.BindConversion(indexSyntax, TypeSymbol.Int32);
            return new BoundIndexExpression(null, target, index, element);
        }

        // Phase 4 exit: CLR indexer read on an imported reference type
        // (e.g. `d["k"]` on Dictionary[string, int]). Pick a public
        // instance indexer (a `PropertyInfo` whose `GetIndexParameters()`
        // matches the single argument by assignability).
        // Issue #209: when the target carries inner-position nullable flags,
        // use them to type the element correctly (e.g., `list[0]` on `List<string?>` → `string?`).
        if (target.Type is NullabilityAnnotatedTypeSymbol annotIdx && annotIdx.ClrType is System.Type clrAnnotIdx)
        {
            var idxArgsAnnot = ImmutableArray.Create(BindExpression(indexSyntax));
            if (this.memberLookup.TryResolveClrIndexer(clrAnnotIdx, idxArgsAnnot, out var idxPropAnnot))
            {
                var elemTypeAnnot = annotIdx.GetTypeArgumentSymbolForClrType(idxPropAnnot.PropertyType);
                return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrIndexExpression(null, target, idxPropAnnot, idxArgsAnnot, elemTypeAnnot));
            }
        }
        else if (target.Type is ImportedTypeSymbol && target.Type.ClrType is System.Type clrTarget)
        {
            var idxArgs = ImmutableArray.Create(BindExpression(indexSyntax));
            if (this.memberLookup.TryResolveClrIndexer(clrTarget, idxArgs, out var idxProp))
            {
                var elementType = MapErasedIndexerElementType((ImportedTypeSymbol)target.Type, idxProp);
                return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrIndexExpression(null, target, idxProp, idxArgs, elementType));
            }
        }

        if (target.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
        }

        return new BoundErrorExpression(null);
    }

    private BoundExpression BindIndexAssignmentExpression(IndexAssignmentExpressionSyntax syntax)
    {
        var name = syntax.TargetIdentifier.Text;
        if (scope.TryLookupSymbol(name) is not VariableSymbol variable)
        {
            Diagnostics.ReportUndefinedVariable(syntax.TargetIdentifier.Location, name);
            return new BoundErrorExpression(null);
        }

        return BindIndexedAssignmentToVariable(variable, syntax.Index, syntax.Value, syntax.TargetIdentifier.Location);
    }

    // Issue #507: indexer assignment whose target is an arbitrary expression
    // (e.g. `obj.Member[k] = v`). The parser produces this node for any LHS
    // shape that parses as an IndexExpression and is followed by `=`. We
    // mirror the user-visible workaround (bind the indexed property to a
    // local first) by synthesizing a temp local that holds the bound target
    // value, then routing the indexer assignment through that temp via the
    // existing variable-rooted path. This reuses every downstream code path
    // (lowering, async spilling, side-effect spilling, evaluation, IL emit)
    // without modification.
    //
    // Follow-up: also handles null-conditional receiver chains
    // (`obj.A?.B[k] = v`). The receiver chain is split at the leftmost `?.`;
    // the left part is captured into a synthetic null-check local and the
    // write is wrapped in a `BoundNullConditionalAccessExpression` so the
    // assignment no-ops when an intermediate is `nil`.
    private BoundExpression BindMemberIndexAssignmentExpression(MemberIndexAssignmentExpressionSyntax syntax)
    {
        return BindIndexedWriteThroughChain(
            chainBase: null,
            remainingChain: syntax.Target.Target,
            indexSyntax: syntax.Target.Index,
            valueSyntax: syntax.Value,
            boundValueOverride: null,
            compoundOperatorToken: null,
            compoundRhsSyntax: null,
            diagnosticLocation: syntax.Target.Target.Location,
            outerSyntax: syntax);
    }

    // Issue #507 follow-up: compound indexer assignment via member chain
    // (`obj.Map[k] += v`, `d[k] -= 1`, ...). Shares the same chain-walking
    // machinery as the plain `=` form so the receiver is evaluated exactly
    // once. The synthesized binary expression (`tmp[k] op v`) is built inside
    // BindIndexedWriteThroughChain after the receiver temp is established.
    private BoundExpression BindCompoundIndexAssignmentExpression(CompoundIndexAssignmentExpressionSyntax syntax)
    {
        return BindIndexedWriteThroughChain(
            chainBase: null,
            remainingChain: syntax.Target.Target,
            indexSyntax: syntax.Target.Index,
            valueSyntax: null,
            boundValueOverride: null,
            compoundOperatorToken: syntax.OperatorToken,
            compoundRhsSyntax: syntax.Value,
            diagnosticLocation: syntax.OperatorToken.Location,
            outerSyntax: syntax);
    }

    // Issue #507 follow-up: shared driver for indexer assignment through a
    // member chain. Handles three orthogonal axes:
    //   * `chainBase` is non-null when recursing past a `?.` capture; the
    //     remainingChain is then bound against the capture via BindAccessorStep
    //     rather than a fresh BindExpression on the syntax tree.
    //   * `compoundOperatorToken` is non-null for `op=` forms; the helper then
    //     synthesizes the `tmp[k] op rhs` binary expression after the receiver
    //     temp is established.
    //   * `boundValueOverride` is non-null when the caller already bound the
    //     RHS (currently unused at top-level, kept for symmetry/future reuse).
    //
    // Null-conditional behaviour: if the chain contains a `?.`, the leftmost
    // occurrence splits the chain. The left side is captured into a synthetic
    // local; the right side (plus the indexer write) becomes the whenNotNull
    // body of a `BoundNullConditionalAccessExpression`. Nested `?.` is handled
    // by recursive splitting.
    //
    // Receiver evaluation: the chain receiver is evaluated exactly once. The
    // index expression is bound twice for compound assignment (once for the
    // read, once for the write) because both target the same syntax node;
    // callers passing side-effecting index expressions should pre-bind them
    // to a local. This matches the precedent set by the local compound
    // assignment desugar (`x += 1` lowers to `x = x + 1` and double-evaluates
    // `x` syntactically).
    private BoundExpression BindIndexedWriteThroughChain(
        BoundExpression chainBase,
        ExpressionSyntax remainingChain,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        BoundExpression boundValueOverride,
        SyntaxToken compoundOperatorToken,
        ExpressionSyntax compoundRhsSyntax,
        TextLocation diagnosticLocation,
        SyntaxNode outerSyntax)
    {
        if (TrySplitAtLeftmostNullConditional(remainingChain, out var leftSyntax, out var rightSyntax))
        {
            BoundExpression boundLeft = chainBase == null
                ? BindExpression(leftSyntax)
                : BindAccessorStep(chainBase, null, leftSyntax);
            if (boundLeft is BoundErrorExpression || boundLeft.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            TypeSymbol underlying;
            if (boundLeft.Type is NullableTypeSymbol nullable)
            {
                underlying = nullable.UnderlyingType;
            }
            else if (boundLeft.Type == TypeSymbol.Null)
            {
                // Statically nil receiver: assignment is a no-op. Produce a
                // bound literal null so the surrounding expression sees a
                // well-typed value; lowering treats `null` literals as
                // statement-position no-ops.
                return new BoundLiteralExpression(null, null);
            }
            else
            {
                // Non-nullable receiver: `?.` degenerates to `.`, but we still
                // produce a nullable result type for syntactic consistency
                // with the read-side null-conditional path.
                underlying = boundLeft.Type;
            }

            var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);
            scope = new BoundScope(scope);
            scope.TryDeclareVariable(capture);

            var captureRef = new BoundVariableExpression(null, capture);
            var whenNotNull = BindIndexedWriteThroughChain(
                chainBase: captureRef,
                remainingChain: rightSyntax,
                indexSyntax,
                valueSyntax,
                boundValueOverride,
                compoundOperatorToken,
                compoundRhsSyntax,
                diagnosticLocation,
                outerSyntax);

            scope = scope.Parent;

            if (whenNotNull is BoundErrorExpression)
            {
                return whenNotNull;
            }

            var resultType = whenNotNull.Type is NullableTypeSymbol
                ? whenNotNull.Type
                : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);

            LocalVariableSymbol resultSlot = null;
            if (whenNotNull.Type is not NullableTypeSymbol
                && whenNotNull.Type?.ClrType is { IsValueType: true })
            {
                var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
                resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
            }

            return new BoundNullConditionalAccessExpression(null, boundLeft, capture, whenNotNull, resultType, resultSlot);
        }

        BoundExpression boundReceiver = chainBase == null
            ? BindExpression(remainingChain)
            : BindAccessorStep(chainBase, null, remainingChain);
        if (boundReceiver is BoundErrorExpression || boundReceiver.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var tempName = $"<idxAsn{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, boundReceiver.Type);
        if (!scope.TryDeclareVariable(tempVar))
        {
            // Defensive: synthesized names cannot collide with user identifiers
            // (the `<...>` prefix is not a valid identifier token), so a failure
            // here means a duplicate synthesized name within the same scope,
            // which Interlocked.Increment guarantees against. Treat as fatal.
            throw new System.InvalidOperationException(
                $"Failed to declare synthesized index-assignment target local '{tempName}'.");
        }

        var declaration = new BoundVariableDeclaration(outerSyntax, tempVar, boundReceiver);

        BoundExpression assignment;
        if (compoundOperatorToken != null)
        {
            if (!SyntaxFacts.TryGetCompoundAssignmentBaseOperator(compoundOperatorToken.Kind, out var baseOpKind))
            {
                // Defensive: parser only emits this node for kinds recognised
                // by TryGetCompoundAssignmentBaseOperator above.
                return new BoundErrorExpression(null);
            }

            var tempRef = new BoundVariableExpression(null, tempVar);
            var indexRead = BindIndexAgainstTarget(tempRef, indexSyntax, diagnosticLocation);
            if (indexRead is BoundErrorExpression)
            {
                return indexRead;
            }

            var rhsBound = BindExpression(compoundRhsSyntax);
            if (rhsBound is BoundErrorExpression || rhsBound.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            var binaryOp = BoundBinaryOperator.Bind(baseOpKind, indexRead.Type, rhsBound.Type);
            if (binaryOp == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(
                    compoundOperatorToken.Location,
                    compoundOperatorToken.Text,
                    indexRead.Type,
                    rhsBound.Type);
                return new BoundErrorExpression(null);
            }

            var combined = new BoundBinaryExpression(null, indexRead, binaryOp, rhsBound);
            assignment = BindIndexedAssignmentToVariableWithBoundValue(tempVar, indexSyntax, combined, diagnosticLocation);
        }
        else if (boundValueOverride != null)
        {
            assignment = BindIndexedAssignmentToVariableWithBoundValue(tempVar, indexSyntax, boundValueOverride, diagnosticLocation);
        }
        else
        {
            assignment = BindIndexedAssignmentToVariable(tempVar, indexSyntax, valueSyntax, diagnosticLocation);
        }

        if (assignment is BoundErrorExpression)
        {
            return assignment;
        }

        return new BoundBlockExpression(outerSyntax, ImmutableArray.Create<BoundStatement>(declaration), assignment);
    }

    // Issue #507 follow-up: walks a left-recursive accessor chain to find the
    // leftmost `?.` in source order. When found, splits the chain into the
    // sub-expression LEFT of the `?.` (which is captured for null-checking)
    // and the sub-expression to its RIGHT (which is bound against the
    // capture). Returns false when the chain contains no `?.` at all.
    private bool TrySplitAtLeftmostNullConditional(
        ExpressionSyntax chain,
        out ExpressionSyntax left,
        out ExpressionSyntax right)
    {
        // ParseNameOrCallExpression makes accessor chains RIGHT-recursive: in
        // `a.b?.c.d`, the outer accessor is `.` with LeftPart `a` and RightPart
        // `AccessorExpression(b, ?., AccessorExpression(c, ., d))`. To find the
        // leftmost `?.` we walk the RIGHT spine: if the current node is itself
        // `?.`, it is the split point; otherwise recurse into RightPart and
        // rebuild the LEFT side by re-attaching the prefix with the inner
        // `?.` replaced by its own LeftPart.
        if (chain is AccessorExpressionSyntax acc)
        {
            if (acc.IsNullConditional)
            {
                left = acc.LeftPart;
                right = acc.RightPart;
                return true;
            }

            if (TrySplitAtLeftmostNullConditional(acc.RightPart, out var innerLeft, out var innerRight))
            {
                left = new AccessorExpressionSyntax(acc.SyntaxTree, acc.LeftPart, acc.DotToken, innerLeft);
                right = innerRight;
                return true;
            }
        }

        left = null;
        right = null;
        return false;
    }

    private BoundExpression BindIndexedAssignmentToVariable(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        TextLocation diagnosticLocation)
    {
        return BindIndexedAssignmentToVariableCore(
            variable, indexSyntax, valueSyntax, boundValueOverride: null, diagnosticLocation);
    }

    // Issue #507 follow-up: compound assignment (`tmp[k] += v`) supplies a
    // pre-bound RHS (the synthesized `tmp[k] op v` binary expression) so the
    // shared body must skip re-binding the value syntax and just convert the
    // bound value to the element type. Carries `diagnosticLocation` for the
    // conversion error site, matching the caller's user-visible operator.
    private BoundExpression BindIndexedAssignmentToVariableWithBoundValue(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        BoundExpression boundValue,
        TextLocation diagnosticLocation)
    {
        return BindIndexedAssignmentToVariableCore(
            variable, indexSyntax, valueSyntax: null, boundValueOverride: boundValue, diagnosticLocation);
    }

    private BoundExpression BindIndexedAssignmentToVariableCore(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        BoundExpression boundValueOverride,
        TextLocation diagnosticLocation)
    {
        BoundExpression BindValue(TypeSymbol elementType)
        {
            if (boundValueOverride != null)
            {
                return conversions.BindConversion(diagnosticLocation, boundValueOverride, elementType);
            }

            return conversions.BindConversion(valueSyntax, elementType);
        }

        var element = GetIndexElementType(variable.Type);
        if (element != null)
        {
            var index = conversions.BindConversion(indexSyntax, TypeSymbol.Int32);
            var value = BindValue(element);
            return new BoundIndexAssignmentExpression(null, variable, index, value, element);
        }

        // Phase 3.A.4: map indexed assignment `m[k] = v` — key bound to K,
        // value bound to V.
        if (variable.Type is MapTypeSymbol mapType)
        {
            var keyExpr = conversions.BindConversion(indexSyntax, mapType.KeyType);
            var valExpr = BindValue(mapType.ValueType);
            return new BoundIndexAssignmentExpression(null, variable, keyExpr, valExpr, mapType.ValueType);
        }

        // Phase 4 exit: CLR indexer write on an imported reference type
        // (e.g. `d["k"] = 1` on Dictionary[string, int]).
        // Issue #209: honour inner-position nullable flags when present.
        if (variable.Type is NullabilityAnnotatedTypeSymbol annotWr && variable.Type.ClrType is System.Type clrAnnotWr)
        {
            var idxArgsAnnotWr = ImmutableArray.Create(BindExpression(indexSyntax));
            if (this.memberLookup.TryResolveClrIndexer(clrAnnotWr, idxArgsAnnotWr, out var idxPropAnnotWr))
            {
                if (!idxPropAnnotWr.CanWrite)
                {
                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
                    return new BoundErrorExpression(null);
                }

                var valueTypeAnnotWr = annotWr.GetTypeArgumentSymbolForClrType(idxPropAnnotWr.PropertyType);
                var boundValueAnnotWr = BindValue(valueTypeAnnotWr);
                return new BoundClrIndexAssignmentExpression(null, variable, idxPropAnnotWr, idxArgsAnnotWr, boundValueAnnotWr, valueTypeAnnotWr);
            }
        }
        else if (variable.Type is ImportedTypeSymbol && variable.Type.ClrType is System.Type clrTarget)
        {
            var idxArgs = ImmutableArray.Create(BindExpression(indexSyntax));
            if (this.memberLookup.TryResolveClrIndexer(clrTarget, idxArgs, out var idxProp))
            {
                // ADR-0056 §2: span element write. `Span[T]` has no `set_Item`; its
                // indexer is a `ref T`-returning getter and writes go through that
                // managed pointer. Detect the ref-returning getter and store through
                // it. A `ReadOnlySpan[T]` getter is `ref readonly T` — writing is a
                // hard error (GS0226).
                if (!idxProp.CanWrite)
                {
                    var refGetter = idxProp.GetGetMethod(nonPublic: false);
                    if (refGetter != null && refGetter.ReturnType.IsByRef)
                    {
                        if (IsReadOnlyRefReturn(idxProp, refGetter))
                        {
                            Diagnostics.ReportCannotAssignReadOnlySpanElement(diagnosticLocation, variable.Type);
                            return new BoundErrorExpression(null);
                        }

                        var pointeeType = TypeSymbol.FromClrType(refGetter.ReturnType.GetElementType()!);
                        var refValue = BindValue(pointeeType);
                        return new BoundClrIndexAssignmentExpression(null, variable, idxProp, idxArgs, refValue, pointeeType);
                    }

                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
                    return new BoundErrorExpression(null);
                }

                var valueType = TypeSymbol.FromClrType(idxProp.PropertyType);
                var boundValue = BindValue(valueType);
                return new BoundClrIndexAssignmentExpression(null, variable, idxProp, idxArgs, boundValue, valueType);
            }
        }

        if (variable.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
        }

        return new BoundErrorExpression(null);
    }

    // #313: for an erased generic indexed in a generic body (e.g. `items[0]`
    // where `items: List[T]`), the closed CLR indexer reports its element type
    // as `object` because the symbol is erased to `List<object>`. Recover the
    // symbolic element type by resolving the indexer on the open definition: if
    // its property type is a generic parameter, map it back to the matching
    // symbolic argument so the result binds as `T` rather than `object`.
    private static TypeSymbol MapErasedIndexerElementType(ImportedTypeSymbol target, PropertyInfo closedIndexer)
    {
        if (target.HasTypeParameterArgument
            && target.OpenDefinition is System.Type openDefinition
            && !target.TypeArguments.IsDefaultOrEmpty)
        {
            try
            {
                var openIndexer = ClrTypeUtilities.SafeGetProperty(
                    openDefinition,
                    closedIndexer.Name,
                    BindingFlags.Public | BindingFlags.Instance);
                if (openIndexer?.PropertyType is System.Type openElement)
                {
                    // ADR-0056 §1/§2: a ref-returning indexer (e.g. `Span[T]`)
                    // surfaces its element as `T&`; map it through a
                    // `ByRefTypeSymbol` so §1 auto-dereference applies.
                    var openCore = openElement.IsByRef ? openElement.GetElementType()! : openElement;
                    if (openCore.IsGenericParameter)
                    {
                        var position = openCore.GenericParameterPosition;
                        if (position >= 0 && position < target.TypeArguments.Length)
                        {
                            var arg = target.TypeArguments[position];
                            return openElement.IsByRef ? ByRefTypeSymbol.Get(arg) : arg;
                        }
                    }
                }
            }
            catch (System.Reflection.AmbiguousMatchException)
            {
                // Fall back to the erased element type below.
            }
        }

        // ADR-0056 §2: a closed ref-returning indexer (e.g. `ReadOnlySpan[int32]`
        // / `Span[int32]`) reports its element as `int32&`. Surface it as a
        // `ByRefTypeSymbol` over the pointee so the read auto-dereferences (§1)
        // and the emitter loads through the managed pointer.
        var propertyType = closedIndexer.PropertyType;
        if (propertyType.IsByRef)
        {
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(propertyType.GetElementType()!));
        }

        return TypeSymbol.FromClrType(propertyType);
    }

    // ADR-0056 §1: map a CLR member's return/field type to a `TypeSymbol`,
    // surfacing a `T&` return as a `ByRefTypeSymbol` over the pointee so that
    // `AutoDereferenceRefReturn` can apply the §1 rule generally to ref-returning
    // methods and properties (not just the span indexer).
    private static TypeSymbol MapClrMemberType(System.Type clrType)
    {
        if (clrType != null && clrType.IsByRef)
        {
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(clrType.GetElementType()!));
        }

        return TypeSymbol.FromClrType(clrType);
    }

    // ADR-0056 §2: a `ref readonly T` return (e.g. `ReadOnlySpan[T].get_Item`)
    // carries a required custom modifier `System.Runtime.InteropServices.InAttribute`
    // on the indexer property / getter return, whereas a `ref T` return
    // (`Span[T].get_Item`) carries none. This distinguishes a writable span
    // element from a read-only one.
    private static bool IsReadOnlyRefReturn(PropertyInfo indexer, MethodInfo getter)
    {
        static bool HasInModifier(System.Type[] modifiers)
        {
            foreach (var m in modifiers)
            {
                if (m.Name == "InAttribute")
                {
                    return true;
                }
            }

            return false;
        }

        if (HasInModifier(indexer.GetRequiredCustomModifiers()))
        {
            return true;
        }

        return HasInModifier(getter.ReturnParameter.GetRequiredCustomModifiers());
    }

    private static TypeSymbol GetIndexElementType(TypeSymbol type)
    {
        return type switch
        {
            ArrayTypeSymbol arr => arr.ElementType,
            SliceTypeSymbol slice => slice.ElementType,
            _ => null,
        };
    }

    private ImmutableArray<BoundExpression> RebindFunctionLiteralDelegateArguments(
        ImmutableArray<BoundExpression> arguments,
        ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping = default)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            var argument = arguments[i];
            var rebound = argument;
            if (paramIndex < parameters.Length
                && LambdaBinder.TryGetFunctionLiteral(argument, out var literal)
                && MemberLookup.TryGetDelegateFunctionType(parameters[paramIndex].ParameterType, out var targetFunctionType)
                && literal.FunctionType != targetFunctionType)
            {
                rebound = lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType);
            }

            if (rebound != argument && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(arguments[j]);
                }
            }

            builder?.Add(rebound);
        }

        if (builder == null)
        {
            return arguments;
        }

        for (var i = builder.Count; i < arguments.Length; i++)
        {
            builder.Add(arguments[i]);
        }

        return builder.ToImmutable();
    }

    private VariableSymbol BindVariableReference(string name, TextLocation location)
    {
        return BindVariableReference(name, location, suppressNotAVariable: false);
    }

    private VariableSymbol BindVariableReference(string name, TextLocation location, bool suppressNotAVariable)
    {
        switch (scope.TryLookupSymbol(name))
        {
            case VariableSymbol variable:
                ReportObsoleteUseIfApplicable(location, variable, variable.Name);
                return variable;

            case null:
                Diagnostics.ReportUndefinedVariable(location, name);
                return null;

            default:
                if (!suppressNotAVariable)
                {
                    Diagnostics.ReportNotAVariable(location, name);
                }

                return null;
        }
    }

    // Issue #324: build a method-group expression for a bare identifier that
    // names a free (package-level) function. Returns false for anything that
    // cannot be materialized as a simple `ldftn` over a static method def:
    // instance methods, generics, variadics, and class statics are excluded.
    private bool TryBindMethodGroup(string name, out BoundExpression methodGroup)
    {
        methodGroup = null;

        // ADR-0063 §9: a name may resolve to multiple user-function overloads.
        // Gather every candidate so BindConversion can pick the one matching the
        // target delegate signature. Fall back to TryLookupSymbol for cases
        // where the name maps to a function not surfaced via the function
        // overload tables (legacy lookup behavior).
        var overloads = scope.TryLookupFunctions(name);
        if (!overloads.IsDefaultOrEmpty)
        {
            var usable = ImmutableArray.CreateBuilder<FunctionSymbol>();
            foreach (var candidate in overloads)
            {
                if (!IsMethodGroupCandidateUsable(candidate))
                {
                    continue;
                }

                usable.Add(candidate);
            }

            if (usable.Count == 1)
            {
                return TryBindSingleMethodGroup(usable[0], out methodGroup);
            }

            if (usable.Count > 1)
            {
                methodGroup = new BoundMethodGroupExpression(null, usable.ToImmutable());
                return true;
            }
        }

        if (scope.TryLookupSymbol(name) is not FunctionSymbol function)
        {
            return false;
        }

        return TryBindSingleMethodGroup(function, out methodGroup);
    }

    private static bool IsMethodGroupCandidateUsable(FunctionSymbol function)
    {
        if (function.IsInstanceMethod
            || function.IsGeneric
            || function.IsExtension
            || function.IsStatic
            || function.StaticOwnerType != null
            || function.Package == null)
        {
            return false;
        }

        foreach (var parameter in function.Parameters)
        {
            if (parameter.IsVariadic)
            {
                return false;
            }
        }

        return true;
    }

    private static bool TryBindSingleMethodGroup(FunctionSymbol function, out BoundExpression methodGroup)
    {
        methodGroup = null;

        if (!IsMethodGroupCandidateUsable(function))
        {
            return false;
        }

        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(function.Parameters.Length);
        foreach (var parameter in function.Parameters)
        {
            parameterTypes.Add(parameter.Type);
        }

        var fnType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), function.Type ?? TypeSymbol.Void);
        methodGroup = new BoundMethodGroupExpression(null, function, fnType);
        return true;
    }

    /// <summary>
    /// Issue #530: returns the CLR type to use when <paramref name="typeSymbol"/>
    /// appears as a generic type argument (e.g. <c>Task[int32?]</c> or
    /// <c>FromResult[string?]</c>). For a <see cref="NullableTypeSymbol"/>
    /// wrapping a value type the result is <c>Nullable&lt;T&gt;</c>; for a
    /// nullable reference type the result is the underlying reference type
    /// (since CLR has no separate <c>string?</c> type).
    /// </summary>
    /// <param name="typeSymbol">The type symbol to resolve.</param>
    /// <returns>
    /// The CLR type projected onto the reference load context, or <c>null</c>
    /// when the symbol has no CLR type.
    /// </returns>
    private Type ResolveClrTypeForGenericArg(TypeSymbol typeSymbol)
    {
        if (typeSymbol is NullableTypeSymbol nullable
            && nullable.UnderlyingType?.ClrType is { IsValueType: true } innerVt
            && this.memberLookup.TryGetNullableConstructedType(innerVt, out var nullableClr))
        {
            return nullableClr;
        }

        var clr = typeSymbol?.ClrType;
        return clr != null ? scope.References.MapClrTypeToReferences(clr) : null;
    }

    /// <summary>
    /// Issue #530: returns the effective CLR <see cref="Type"/> to use when
    /// matching an argument in overload resolution. Delegates to
    /// <see cref="NullableTypeSymbol.GetEffectiveClrType"/>.
    /// </summary>
    private Type GetEffectiveArgumentClrType(TypeSymbol typeSymbol)
    {
        return NullableTypeSymbol.GetEffectiveClrType(typeSymbol);
    }

    // Issue #337: build an (unresolved) CLR member method-group expression for a
    // member name that resolves to a method on an imported static type or a CLR
    // instance receiver. Collects every accessible name-matching overload of the
    // requested static-ness; overload selection happens later in BindConversion
    // once the target delegate signature is known. Returns false when the type
    // exposes no method of that name (so the caller surfaces the member
    // diagnostic).
    private bool TryBindClrMethodGroup(BoundExpression receiver, Type declaringType, bool wantStatic, string name, out BoundExpression methodGroup)
    {
        methodGroup = null;

        if (declaringType == null)
        {
            return false;
        }

        var flags = BindingFlags.Public | (wantStatic ? BindingFlags.Static : BindingFlags.Instance);
        var candidates = ImmutableArray.CreateBuilder<MethodInfo>();

        // Issue #529: use interface-aware method enumeration so that
        // methods declared on a base interface are included in the
        // method group for delegate conversions / member access.
        foreach (var method in ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(declaringType, flags))
        {
            if (!string.Equals(method.Name, name, StringComparison.Ordinal))
            {
                continue;
            }

            // Open generic methods and special-name accessors (property/event
            // get_/set_/add_/remove_) are not directly convertible method-group
            // members.
            if (method.IsGenericMethodDefinition || method.IsSpecialName)
            {
                continue;
            }

            candidates.Add(method);
        }

        if (candidates.Count == 0)
        {
            return false;
        }

        methodGroup = new BoundClrMethodGroupExpression(null, receiver, declaringType, name, candidates.ToImmutable());
        return true;
    }

    // ADR-0047 §6 / #175: if <paramref name="symbol"/> carries an
    // [Obsolete] attribute, surface a use-site diagnostic at
    // <paramref name="location"/>. Severity is Warning by default,
    // promoted to Error when the attribute's second positional
    // argument (IsError) is true.
    private void ReportObsoleteUseIfApplicable(TextLocation location, Symbol symbol, string displayName)
    {
        if (symbol == null)
        {
            return;
        }

        if (KnownAttributes.TryGetObsolete(symbol.Attributes, out var message, out var isError))
        {
            Diagnostics.ReportObsoleteUse(location, displayName, message, isError);
        }
    }

    private TypeSymbol LookupType(string name)
    {
        // Phase 4.1 / ADR-0020: a generic function's type parameters shadow
        // outer type names while we are binding its signature and body.
        if (binderCtx.CurrentTypeParameters != null && binderCtx.CurrentTypeParameters.TryGetValue(name, out var tp))
        {
            return tp;
        }

        switch (name)
        {
            case "bool":
                return TypeSymbol.Bool;
            case "uint8":
                return TypeSymbol.UInt8;
            case "int8":
                return TypeSymbol.Int8;
            case "int16":
                return TypeSymbol.Int16;
            case "uint16":
                return TypeSymbol.UInt16;
            case "int32":
                return TypeSymbol.Int32;
            case "uint32":
                return TypeSymbol.UInt32;
            case "int64":
                return TypeSymbol.Int64;
            case "uint64":
                return TypeSymbol.UInt64;
            case "nint":
                return TypeSymbol.NInt;
            case "nuint":
                return TypeSymbol.NUInt;
            case "float32":
                return TypeSymbol.Float32;
            case "float64":
                return TypeSymbol.Float64;
            case "decimal":
                return TypeSymbol.Decimal;
            case "char":
                return TypeSymbol.Char;
            case "string":
                return TypeSymbol.String;
            case "object":
                return TypeSymbol.Object;
        }

        if (scope.TryLookupTypeAlias(name, out var aliased))
        {
            return aliased;
        }

        if (scope.TryLookupImportedClass(name, declaration: null, out var importedClass))
        {
            return TypeSymbol.FromClrType(importedClass.ClassType);
        }

        return null;
    }

    /// <summary>
    /// Issue #525: resolves a class declaration's base-type identifier to an
    /// imported CLR interface. Honors imports and aliases (via
    /// <see cref="LookupType"/>) for simple names and falls back to direct
    /// fully-qualified resolution against the reference set. Only public
    /// CLR interface types are accepted; classes, value types, and other
    /// references are rejected so the regular "cannot find type" diagnostic
    /// still applies.
    /// </summary>
    /// <param name="name">The identifier text as written in the base clause.</param>
    /// <param name="importedInterface">The resolved CLR interface type symbol on success.</param>
    /// <returns><see langword="true"/> when the name resolves to an imported CLR interface; otherwise <see langword="false"/>.</returns>
    private bool TryResolveImportedInterface(string name, out TypeSymbol importedInterface)
    {
        importedInterface = null;

        // Simple name honoring imports/aliases. This is the same path used
        // by expression-type contexts (e.g. `var g IClrInterface = ...`),
        // which is why those contexts already find the interface today.
        var candidate = LookupType(name)?.ClrType;

        // Fully-qualified fallback against the reference set
        // (e.g. `System.IDisposable`).
        if (candidate == null && scope.References.TryResolveType(name, out var resolved))
        {
            candidate = resolved;
        }

        // Issue #526: dotted-qualifier names such as `Outer.INested` or
        // `Probe.CSharp.Outer.INested` mean a NESTED CLR interface — walk the
        // dotted name with Type.GetNestedType for the tail segments.
        if (candidate == null && name.Contains('.'))
        {
            candidate = TryResolveDottedClrType(name);
        }

        // TODO(issue-525): generic CLR interfaces (e.g. `IComparable<T>`)
        // require a base-type clause grammar that accepts a type-argument
        // list. The single-identifier base-type syntax can only name the
        // open definition, which is rejected here; closing it requires
        // additional parser work and is left for a follow-up issue.
        if (candidate == null || !candidate.IsInterface || candidate.IsGenericTypeDefinition)
        {
            return false;
        }

        importedInterface = TypeSymbol.FromClrType(candidate);
        return importedInterface?.ClrType != null;
    }

    /// <summary>
    /// Issue #296: resolves a class declaration's base-type name to an imported
    /// CLR base class. Honors imports and aliases (via <see cref="LookupType"/>)
    /// for simple names and falls back to direct fully-qualified resolution.
    /// Only non-sealed reference (class) types are accepted as a base; CLR
    /// interfaces, value types, and sealed classes are rejected so the regular
    /// "cannot find type" / single-inheritance diagnostics still apply.
    /// </summary>
    private bool TryResolveImportedBaseType(string baseName, out TypeSymbol importedBaseType)
    {
        importedBaseType = null;

        // Simple name honoring imports/aliases, e.g. `MemoryStream` with
        // `import System.IO`. This is the same path used to resolve imported
        // types for construction and static access.
        var candidate = LookupType(baseName)?.ClrType;

        // Fully-qualified name, e.g. `System.IO.MemoryStream`, resolved directly
        // against the reference set.
        if (candidate == null && scope.References.TryResolveType(baseName, out var resolvedType))
        {
            candidate = resolvedType;
        }

        // Issue #526: dotted-qualifier names such as `Outer.NestedClass` mean a
        // NESTED CLR class — walk the dotted name with Type.GetNestedType.
        if (candidate == null && baseName.Contains('.'))
        {
            candidate = TryResolveDottedClrType(baseName);
        }

        if (candidate == null || !candidate.IsClass || candidate.IsInterface || candidate.IsSealed)
        {
            return false;
        }

        importedBaseType = TypeSymbol.FromClrType(candidate);
        return importedBaseType?.ClrType != null;
    }

    /// <summary>
    /// Issue #526: resolves a dotted-string CLR type name such as
    /// <c>Outer.Inner</c> or <c>Probe.CSharp.Outer.Inner</c> into a
    /// <see cref="System.Type"/>. Strategy: take increasingly long prefixes
    /// (joined by <c>.</c>) as the outer type and walk the remaining
    /// segments as nested types via <see cref="Type.GetNestedType(string, BindingFlags)"/>,
    /// returning the deepest match. Honors imports as a namespace prefix on
    /// the outer portion, matching <see cref="BindQualifiedTypeName"/>.
    /// Returns <c>null</c> when no split yields a fully resolvable type chain.
    /// </summary>
    private System.Type TryResolveDottedClrType(string dottedName)
    {
        if (string.IsNullOrEmpty(dottedName) || !dottedName.Contains('.'))
        {
            return null;
        }

        var segments = dottedName.Split('.');
        for (var outerLen = segments.Length; outerLen >= 1; outerLen--)
        {
            System.Type outer;
            if (outerLen == 1)
            {
                outer = LookupType(segments[0])?.ClrType;
            }
            else
            {
                var prefix = string.Join(".", segments, 0, outerLen);
                if (!scope.References.TryResolveType(prefix, out outer))
                {
                    outer = null;
                }

                if (outer == null)
                {
                    foreach (var import in scope.GetDeclaredImports())
                    {
                        if (scope.References.TryResolveType(import.Target + "." + prefix, out var viaImport))
                        {
                            outer = viaImport;
                            break;
                        }
                    }
                }
            }

            if (outer == null)
            {
                continue;
            }

            var current = outer;
            var resolved = true;
            for (var i = outerLen; i < segments.Length; i++)
            {
                if (!scope.References.TryResolveNestedType(current, segments[i], out var next))
                {
                    resolved = false;
                    break;
                }

                current = next;
            }

            if (resolved)
            {
                return current;
            }
        }

        return null;
    }

    /// <summary>
    /// Picks or synthesizes the entry-point function symbol for the compilation
    /// per the rules in design/Gsharp-design-v0.1.md (C#-9-style top-level
    /// statements). Reports diagnostics for ambiguity.
    /// </summary>
    private static FunctionSymbol ResolveEntryPoint(
        Binder binder,
        ImmutableArray<FunctionSymbol> functions,
        GlobalStatementSyntax[] globalStatements,
        ImmutableArray<SyntaxTree> syntaxTrees,
        PackageSymbol entryPointPackage)
    {
        var explicitMain = functions.FirstOrDefault(f => f.Name == "Main");
        var hasTopLevel = globalStatements.Length > 0;

        if (hasTopLevel)
        {
            // Top-level statements must live in exactly one *package*. Multiple
            // files within the same package may collectively contribute top-level
            // statements (matching the C# "one Program type per assembly" rule
            // relaxed to packages).
            var packagesWithTopLevel = syntaxTrees
                .Where(st => st.Root.Members.OfType<GlobalStatementSyntax>().Any())
                .Select(st =>
                {
                    var pkgSyntax = st.Root.Members.OfType<PackageSyntax>().FirstOrDefault();
                    return pkgSyntax != null
                        ? string.Concat(pkgSyntax.IdentifiersWithDots.Select(t => t.Text))
                        : "Default";
                })
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (packagesWithTopLevel.Length > 1)
            {
                foreach (var tree in syntaxTrees.Where(st => st.Root.Members.OfType<GlobalStatementSyntax>().Any()))
                {
                    var first = tree.Root.Members.OfType<GlobalStatementSyntax>().First();
                    binder.Diagnostics.ReportMultipleTopLevelFiles(first.Statement.Location);
                }
            }

            if (explicitMain != null)
            {
                binder.Diagnostics.ReportTopLevelStatementsConflictWithMain(
                    explicitMain.Declaration.Identifier.Location);
            }

            return SynthesizeTopLevelEntryPoint(entryPointPackage);
        }

        return explicitMain;
    }

    private static FunctionSymbol SynthesizeTopLevelEntryPoint(PackageSymbol package)
    {
        // <Main>$ — Roslyn-style mangled name; not a legal user identifier so it
        // cannot collide with a user-declared function.
        return new FunctionSymbol(
            name: "<Main>$",
            parameters: ImmutableArray<ParameterSymbol>.Empty,
            type: TypeSymbol.Void,
            declaration: null,
            package: package);
    }

    private static PackageSymbol ResolveEntryPointPackage(
        Dictionary<SyntaxTree, PackageSymbol> packageByTree,
        GlobalStatementSyntax[] globalStatements,
        ImmutableArray<FunctionSymbol> functions,
        ImmutableArray<PackageSymbol>.Builder packagesInOrder)
    {
        if (globalStatements.Length > 0)
        {
            return packageByTree[globalStatements[0].SyntaxTree];
        }

        var explicitMain = functions.FirstOrDefault(f => f.Name == "Main");
        if (explicitMain?.Package != null)
        {
            return explicitMain.Package;
        }

        return packagesInOrder.Count > 0
            ? packagesInOrder[0]
            : new PackageSymbol("Default", declaration: null);
    }

    /// <summary>
    /// Attaches authored documentation from a G# doc comment to a symbol (ADR-0057 §7/§8).
    /// Parses the block text from the syntax tree side-table and calls <see cref="Symbol.SetDocumentation"/>.
    /// </summary>
    /// <param name="symbol">The symbol that should receive the parsed documentation.</param>
    /// <param name="syntax">The syntax node whose attached doc-comment text is being attached.</param>
    internal static void AttachDocumentation(Symbol symbol, SyntaxNode syntax)
    {
        var docText = syntax?.SyntaxTree?.GetDocumentation(syntax);
        if (docText == null)
        {
            return;
        }

        var doc = GSharpDocumentationParser.Parse(docText);
        if (doc != null)
        {
            symbol.SetDocumentation(doc);
        }
    }
#pragma warning restore SA1202
}