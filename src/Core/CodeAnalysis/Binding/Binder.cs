// <copyright file="Binder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
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
    private readonly List<(StructDeclarationSyntax Syntax, StructSymbol Symbol)> pendingInterfaceImplementationChecks
        = new List<(StructDeclarationSyntax, StructSymbol)>();

    /// <summary>
    /// Targets permitted on a function declaration (member or free):
    /// <c>method</c> by default; <c>return</c> via use-site qualifier.
    /// </summary>
    private static readonly ImmutableHashSet<AttributeTargetKind> FunctionDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Method, AttributeTargetKind.Return);

    /// <summary>
    /// Targets permitted on a parameter: only <c>param</c>.
    /// </summary>
    private static readonly ImmutableHashSet<AttributeTargetKind> ParameterAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Param);

    /// <summary>
    /// Targets permitted on a type-shaped declaration
    /// (<c>struct</c> / <c>interface</c> / <c>enum</c> / type alias).
    /// </summary>
    private static readonly ImmutableHashSet<AttributeTargetKind> TypeDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Type);

    /// <summary>
    /// Targets permitted on a field declaration: only <c>field</c>.
    /// </summary>
    private static readonly ImmutableHashSet<AttributeTargetKind> FieldDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Field);

    /// <summary>
    /// Targets permitted on a property declaration (ADR-0051):
    /// <c>property</c> by default; <c>field</c> for the backing field;
    /// <c>method</c> for the synthesized accessors.
    /// </summary>
    private static readonly ImmutableHashSet<AttributeTargetKind> PropertyDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Property, AttributeTargetKind.Field, AttributeTargetKind.Method);

    /// <summary>
    /// Targets permitted on an event declaration (ADR-0052):
    /// <c>event</c> by default; <c>field</c> for the backing field;
    /// <c>method</c> for the synthesized add/remove accessors.
    /// </summary>
    private static readonly ImmutableHashSet<AttributeTargetKind> EventDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Event, AttributeTargetKind.Field, AttributeTargetKind.Method);

    /// <summary>
    /// Targets permitted on a <c>var</c>/<c>let</c>/<c>const</c> variable
    /// declaration. ADR-0047 §2 assigns the default target <c>field</c> to
    /// these declarations (both at top level — where the variable becomes a
    /// CLR static field — and in local scope — where the attribute carries
    /// compiler-recognised semantics like <c>@Obsolete</c> for use-site
    /// diagnostics).
    /// </summary>
    private static readonly ImmutableHashSet<AttributeTargetKind> VariableDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Field);

    private FunctionSymbol function;

    private Stack<(BoundLabel BreakLabel, BoundLabel ContinueLabel)> loopStack = new Stack<(BoundLabel BreakLabel, BoundLabel ContinueLabel)>();
    private int labelCounter;
    private int nullConditionalCaptureCounter;
    private int syntheticLocalCounter;
    private int deferArgumentCounter;
    private List<Dictionary<VariableSymbol, TypeSymbol>> narrowedVariables = new List<Dictionary<VariableSymbol, TypeSymbol>>();
    private Dictionary<string, TypeParameterSymbol> currentTypeParameters;
    private BoundScope scope;

    // Issue #294: cache of imported static [Extension] classes for
    // instance-syntax extension-method dispatch. Recomputed when the import
    // count changes (imports only grow during binding).
    private List<Type> cachedImportedExtensionClasses;
    private int cachedImportedExtensionImportCount = -1;

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
        scope = new BoundScope(parent);
        this.function = function;

        if (function != null)
        {
            if (function.ThisParameter != null)
            {
                scope.TryDeclareVariable(function.ThisParameter);

                // Phase 3.B.3 sub-step 2b: expose each field on the receiver
                // as a bare name inside the method body. Field access lowers
                // to `this.<field>` at name resolution time.
                // Sub-step 3: walk inheritance chain so inherited fields are
                // also accessible via bare name. Derived shadowing wins.
                if (function.ReceiverType is StructSymbol receiverStruct)
                {
                    var seenFields = new HashSet<string>();
                    for (var t = receiverStruct; t != null; t = t.BaseClass)
                    {
                        if (t.Fields.IsDefaultOrEmpty)
                        {
                            continue;
                        }

                        foreach (var fld in t.Fields)
                        {
                            if (seenFields.Add(fld.Name))
                            {
                                scope.TryDeclareVariable(new ImplicitFieldVariableSymbol(function.ThisParameter, t, fld));
                            }
                        }
                    }
                }
            }

            // Issue #261 / ADR-0053: expose sibling static fields as bare names
            // inside shared method bodies so `x` resolves without requiring
            // `TypeName.x`. Skip fields whose name collides with a parameter
            // so that parameters shadow static fields naturally.
            if (function.IsStatic && function.StaticOwnerType is StructSymbol ownerStruct)
            {
                if (!ownerStruct.StaticFields.IsDefaultOrEmpty)
                {
                    var paramNames = new HashSet<string>(function.Parameters.Select(p => p.Name));
                    foreach (var fld in ownerStruct.StaticFields)
                    {
                        if (!paramNames.Contains(fld.Name))
                        {
                            scope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(ownerStruct, fld));
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
                currentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                foreach (var tp in enclosingTypeParams)
                {
                    currentTypeParameters[tp.Name] = tp;
                }

                foreach (var tp in function.TypeParameters)
                {
                    currentTypeParameters[tp.Name] = tp;
                }
            }
        }
    }

    /// <summary>
    /// Gets the diagnostics bag.
    /// </summary>
    public DiagnosticBag Diagnostics { get; } = new DiagnosticBag();

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
            binder.BindTypeAliasDeclaration(typeAlias);
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
            var sym = binder.DeclareInterfaceSymbol(ifaceSyntax, owningPackage);
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
            binder.BindEnumDeclaration(enumSyntax, owningPackage);
        }

        var structDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                            .OfType<StructDeclarationSyntax>();
        foreach (var structSyntax in structDeclarations)
        {
            var owningPackage = packageByTree[structSyntax.SyntaxTree];
            binder.BindStructDeclaration(structSyntax, owningPackage);
        }

        foreach (var (ifaceSyntax, ifaceSymbol) in declaredInterfaces)
        {
            var owningPackage = packageByTree[ifaceSyntax.SyntaxTree];
            binder.BindInterfaceMembers(ifaceSyntax, ifaceSymbol, owningPackage);
        }

        var functionDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                              .OfType<FunctionDeclarationSyntax>();
        foreach (var function in functionDeclarations)
        {
            var owningPackage = packageByTree[function.SyntaxTree];
            binder.BindFunctionDeclaration(function, owningPackage);
        }

        binder.VerifyInterfaceImplementations();

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var globalStatements = syntaxTrees.SelectMany(st => st.Root.Members)
                                          .OfType<GlobalStatementSyntax>()
                                          .ToArray();
        foreach (var globalStatement in globalStatements)
        {
            var statement = binder.BindStatement(globalStatement.Statement);
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

        var result = new BoundGlobalScope(previous, entryPointPackage, packagesInOrder.ToImmutable(), diagnostics, imports, functions, variables, typeAliases, structs, interfaces, enums, entryPoint, statements.ToImmutable());
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
                var body = binder.BindStatement(function.Declaration.Body);
                var loweredBody = Lowerer.Lower(body);

                if (function.Type != TypeSymbol.Void && !IsIteratorReturnType(function.Type) && !ControlFlowGraph.AllPathsReturn(loweredBody))
                {
                    binder.Diagnostics.ReportAllPathsMustReturn(function.Declaration.Identifier.Location);
                }

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
                var body = binder.BindStatement(method.Declaration.Body);
                var loweredBody = Lowerer.Lower(body);

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
        foreach (var structSym in globalScope.Structs)
        {
            var ctor = structSym.ExplicitConstructor;
            if (ctor == null)
            {
                continue;
            }

            var ctorBinder = new Binder(parentScope, ctor.Function);
            var ctorBody = ctorBinder.BindStatement(ctor.Declaration.Body);
            var ctorLoweredBody = Lowerer.Lower(ctorBody);
            functionBodies.Add(ctor.Function, ctorLoweredBody);
            diagnostics.AddRange(ctorBinder.Diagnostics);
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
                        var body = binder.BindStatement(prop.GetterBodySyntax);
                        var loweredBody = Lowerer.Lower(body);

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
                        var body = binder.BindStatement(prop.SetterBodySyntax);
                        var loweredBody = Lowerer.Lower(body);
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
                        var body = binder.BindStatement(ev.AddBodySyntax);
                        var loweredBody = Lowerer.Lower(body);
                        functionBodies.Add(ev.AddMethodSymbol, loweredBody);
                        diagnostics.AddRange(binder.Diagnostics);
                    }

                    if (ev.RemoveMethodSymbol != null && ev.RemoveBodySyntax != null)
                    {
                        var binder = new Binder(parentScope, ev.RemoveMethodSymbol);
                        var body = binder.BindStatement(ev.RemoveBodySyntax);
                        var loweredBody = Lowerer.Lower(body);
                        functionBodies.Add(ev.RemoveMethodSymbol, loweredBody);
                        diagnostics.AddRange(binder.Diagnostics);
                    }

                    // Issue #257: bind raise accessor body.
                    if (ev.RaiseMethodSymbol != null && ev.RaiseBodySyntax != null)
                    {
                        var binder = new Binder(parentScope, ev.RaiseMethodSymbol);
                        var body = binder.BindStatement(ev.RaiseBodySyntax);
                        var loweredBody = Lowerer.Lower(body);
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
                    var body = binder.BindStatement(prop.GetterBodySyntax);
                    var loweredBody = Lowerer.Lower(body);

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
                    var body = binder.BindStatement(prop.SetterBodySyntax);
                    var loweredBody = Lowerer.Lower(body);
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
                    var body = binder.BindStatement(ev.AddBodySyntax);
                    var loweredBody = Lowerer.Lower(body);
                    functionBodies.Add(ev.AddMethodSymbol, loweredBody);
                    diagnostics.AddRange(binder.Diagnostics);
                }

                if (ev.RemoveMethodSymbol != null && ev.RemoveBodySyntax != null)
                {
                    var binder = new Binder(parentScope, ev.RemoveMethodSymbol);
                    var body = binder.BindStatement(ev.RemoveBodySyntax);
                    var loweredBody = Lowerer.Lower(body);
                    functionBodies.Add(ev.RemoveMethodSymbol, loweredBody);
                    diagnostics.AddRange(binder.Diagnostics);
                }

                // Issue #257: bind raise accessor body for static events.
                if (ev.RaiseMethodSymbol != null && ev.RaiseBodySyntax != null)
                {
                    var binder = new Binder(parentScope, ev.RaiseMethodSymbol);
                    var body = binder.BindStatement(ev.RaiseBodySyntax);
                    var loweredBody = Lowerer.Lower(body);
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
                var body = binder.BindStatement(method.Declaration.Body);
                var loweredBody = Lowerer.Lower(body);

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

        return new BoundProgram(globalScope.Package, globalScope.Packages, diagnostics.ToImmutable(), functionBodies.ToImmutable(), globalScope.EntryPoint, statement, globalScope.Structs, globalScope.Interfaces, globalScope.Enums, globals)
        {
            Imports = globalScope.Imports,
        };
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
        scope.TryImport(importSymbol);
    }

    private void BindTypeAliasDeclaration(TypeAliasDeclarationSyntax syntax)
    {
        var name = syntax.Identifier.Text;

        // Reject shadowing of primitive type names.
        if (IsPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return;
        }

        var aliasedType = BindTypeClause(syntax.AliasedType);
        if (aliasedType == null)
        {
            return;
        }

        // Issue #141 / ADR-0047: type aliases accept annotations syntactically;
        // since the alias has no dedicated symbol of its own, the resolved
        // attribute list is reported for diagnostics and otherwise dropped
        // until v2 introduces a richer alias-symbol shape.
        BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            TypeDeclarationAllowedTargets,
            "a type alias declaration",
            System.AttributeTargets.Class);

        if (!scope.TryDeclareTypeAlias(name, aliasedType))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }
    }

    private void BindEnumDeclaration(EnumDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;

        if (IsPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return;
        }

        var accessibility = ResolveAccessibility(syntax.AccessibilityModifier);
        var enumSymbol = new EnumSymbol(name, accessibility, package.Name, syntax);
        enumSymbol.SetAttributes(BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            TypeDeclarationAllowedTargets,
            "an enum declaration",
            System.AttributeTargets.Enum));

        var seenMemberNames = new HashSet<string>();
        var members = ImmutableArray.CreateBuilder<EnumMemberSymbol>();
        foreach (var memberSyntax in syntax.Members)
        {
            var memberName = memberSyntax.Identifier.Text;
            if (!seenMemberNames.Add(memberName))
            {
                Diagnostics.ReportDuplicateEnumMember(memberSyntax.Identifier.Location, memberName, name);
                continue;
            }

            var memberSymbol = new EnumMemberSymbol(memberName, enumSymbol, members.Count);

            // Issue #188 / ADR-0047 §3: bind any `@Foo` annotations attached
            // to the enum-member entry with default target `field` (enum
            // members are emitted as static literal fields on the enum type
            // per ECMA-335 §I.8.5.2), so #175 use-site diagnostics
            // (e.g. `@Obsolete`) fire on `Color.Red` references.
            if (!memberSyntax.Annotations.IsDefaultOrEmpty)
            {
                memberSymbol.SetAttributes(BindAttributes(
                    memberSyntax.Annotations,
                    AttributeTargetKind.Field,
                    VariableDeclarationAllowedTargets,
                    "an enum member declaration",
                    System.AttributeTargets.Field));
            }

            members.Add(memberSymbol);
        }

        if (members.Count == 0)
        {
            Diagnostics.ReportEmptyEnumDeclaration(syntax.Identifier.Location, name);
        }

        enumSymbol.SetMembers(members.ToImmutable());

        if (!scope.TryDeclareTypeAlias(name, enumSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }
    }

    private void BindStructDeclaration(StructDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;

        if (IsPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return;
        }

        var accessibility = ResolveAccessibility(syntax.AccessibilityModifier);

        // Phase 4.3 / ADR-0020: bind the optional type-parameter list FIRST so
        // field/parameter types in the body can reference T, U, etc.
        var previousTypeParameters = currentTypeParameters;
        ImmutableArray<TypeParameterSymbol> typeParameters = ImmutableArray<TypeParameterSymbol>.Empty;
        try
        {
            if (syntax.TypeParameterList != null)
            {
                currentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                typeParameters = BindTypeParameterList(syntax.TypeParameterList);
                foreach (var tp in typeParameters)
                {
                    currentTypeParameters[tp.Name] = tp;
                }
            }

            BindStructDeclarationBody(syntax, package, accessibility, name, typeParameters);
        }
        finally
        {
            currentTypeParameters = previousTypeParameters;
        }
    }

    private void BindStructDeclarationBody(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        Accessibility accessibility,
        string name,
        ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        var seenFieldNames = new HashSet<string>();
        var fields = ImmutableArray.CreateBuilder<FieldSymbol>();

        // Phase 3.B.3 sub-step 2: Kotlin-style primary constructor parameters
        // declare fields of the same name + type, in source order, in addition
        // to becoming the ctor's parameters.
        var primaryCtorParameters = ImmutableArray<ParameterSymbol>.Empty;
        if (syntax.HasPrimaryConstructor)
        {
            var ctorBuilder = ImmutableArray.CreateBuilder<ParameterSymbol>();
            foreach (var paramSyntax in syntax.PrimaryConstructorParameters)
            {
                var paramName = paramSyntax.Identifier.Text;
                var paramType = BindTypeClause(paramSyntax.Type);
                if (paramType == null)
                {
                    continue;
                }

                if (!seenFieldNames.Add(paramName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(paramSyntax.Identifier.Location, paramName);
                    continue;
                }

                ctorBuilder.Add(new ParameterSymbol(paramName, paramType, declaringSyntax: paramSyntax.Identifier));
                fields.Add(new FieldSymbol(paramName, paramType, Accessibility.Public, isReadOnly: syntax.IsInline));
            }

            primaryCtorParameters = ctorBuilder.ToImmutable();
        }

        foreach (var fieldSyntax in syntax.Fields)
        {
            var fieldName = fieldSyntax.Identifier.Text;
            if (!seenFieldNames.Add(fieldName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName);
                continue;
            }

            var fieldType = BindTypeClause(fieldSyntax.Type);
            if (fieldType == null)
            {
                continue;
            }

            var fieldAccessibility = ResolveAccessibility(fieldSyntax.AccessibilityModifier);
            var fieldSymbol = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: syntax.IsInline);

            // Issue #186 / ADR-0047 §3: bind any `@Foo` annotations attached
            // to the field declaration with default target `field` so #175
            // use-site diagnostics (e.g. `@Obsolete`) fire on field reads
            // and writes, and #170-style `CustomAttribute` rows are emitted
            // onto the FieldDef.
            if (!fieldSyntax.Annotations.IsDefaultOrEmpty)
            {
                fieldSymbol.SetAttributes(BindAttributes(
                    fieldSyntax.Annotations,
                    AttributeTargetKind.Field,
                    FieldDeclarationAllowedTargets,
                    "a field declaration",
                    System.AttributeTargets.Field));
            }

            fields.Add(fieldSymbol);
        }

        if (syntax.IsData && fields.Count == 0)
        {
            Diagnostics.ReportEmptyDataStruct(syntax.Identifier.Location, name);
        }

        if (syntax.IsInline)
        {
            if (syntax.IsData)
            {
                Diagnostics.ReportInlineCannotBeCombinedWithData(syntax.InlineKeyword.Location);
            }

            if (syntax.IsOpen)
            {
                Diagnostics.ReportInlineCannotBeCombinedWithOpen(syntax.OpenModifier.Location);
            }

            if (fields.Count != 1)
            {
                Diagnostics.ReportInlineStructRequiresExactlyOneField(syntax.Identifier.Location, name, fields.Count);
            }
        }

        // Phase 4 of #141 / ADR-0047 §5: detect the `@Attribute` declaration
        // sugar marker before resolving the base clause so we can tolerate
        // an explicit `: System.Attribute` (redundant restatement) and reject
        // any conflicting explicit base.
        var hasAttributeSugar = HasAttributeSugarMarker(syntax.Annotations);

        // Phase 3.B.3 sub-step 3 + 3.B.4: resolve the optional `: X, Y, Z` clause.
        // Each identifier is either the (single) base class or an interface
        // implemented by this class. A base class, if present, must be the
        // first identifier. Declaration order rules apply: base/interfaces
        // must be declared before this type.
        StructSymbol baseClassSymbol = null;
        TypeSymbol importedBaseType = null;
        var implementedInterfaces = ImmutableArray.CreateBuilder<InterfaceSymbol>();
        if (syntax.HasBaseType)
        {
            if (!syntax.IsClass)
            {
                Diagnostics.ReportUnexpectedToken(syntax.BaseColonToken.Location, SyntaxKind.ColonToken, SyntaxKind.OpenBraceToken);
            }
            else
            {
                var allBaseTokens = ImmutableArray.CreateBuilder<SyntaxToken>();
                allBaseTokens.Add(syntax.BaseTypeIdentifier);
                if (!syntax.AdditionalBaseTypeIdentifiers.IsDefaultOrEmpty)
                {
                    allBaseTokens.AddRange(syntax.AdditionalBaseTypeIdentifiers);
                }

                for (var i = 0; i < allBaseTokens.Count; i++)
                {
                    var token = allBaseTokens[i];
                    var baseName = token.Text;

                    // Phase 4 of #141: tolerate an explicit `: Attribute` on an
                    // @Attribute-marked class (redundant restatement). The
                    // System.Attribute base is supplied by the emitter.
                    if (hasAttributeSugar && i == 0
                        && (baseName == "Attribute" || baseName == "System.Attribute"))
                    {
                        continue;
                    }

                    if (!scope.TryLookupTypeAlias(baseName, out var resolved))
                    {
                        // Issue #296: a GSharp class may inherit from an imported
                        // (CLR) base class. The base-type name did not match any
                        // user-declared GSharp type, so consult the same imported
                        // type resolution used for construction / static access.
                        // Only the first identifier (the base-class slot) may be
                        // a CLR class; the rest are interfaces (CLR interface
                        // implementation is out of scope here).
                        if (i == 0 && !hasAttributeSugar
                            && TryResolveImportedBaseType(baseName, out var importedBase))
                        {
                            importedBaseType = importedBase;
                            continue;
                        }

                        Diagnostics.ReportUnableToFindType(token.Location, baseName);
                        continue;
                    }

                    if (resolved is InterfaceSymbol iface)
                    {
                        implementedInterfaces.Add(iface);
                        continue;
                    }

                    if (resolved is StructSymbol baseStruct && baseStruct.IsClass)
                    {
                        if (i != 0)
                        {
                            Diagnostics.ReportUnableToFindType(token.Location, baseName);
                            continue;
                        }

                        if (hasAttributeSugar)
                        {
                            // Phase 4 of #141 / ADR-0047 §5: @Attribute sugar
                            // forces System.Attribute as the base; conflict.
                            Diagnostics.ReportAttributeClassExplicitBase(token.Location, baseName);
                            continue;
                        }

                        if (!baseStruct.IsOpen)
                        {
                            Diagnostics.ReportBaseClassNotOpen(token.Location, baseName);
                            continue;
                        }

                        baseClassSymbol = baseStruct;
                        continue;
                    }

                    Diagnostics.ReportUnableToFindType(token.Location, baseName);
                }
            }
        }

        var structSymbol = new StructSymbol(
            name,
            fields.ToImmutable(),
            accessibility,
            syntax,
            package.Name,
            syntax.IsData,
            syntax.IsInline,
            syntax.IsClass,
            primaryCtorParameters,
            isOpen: syntax.IsOpen && syntax.IsClass,
            baseClass: baseClassSymbol);

        if (!typeParameters.IsDefaultOrEmpty)
        {
            structSymbol.SetTypeParameters(typeParameters);
        }

        structSymbol.SetAttributes(BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            TypeDeclarationAllowedTargets,
            syntax.IsClass ? "a class declaration" : "a struct declaration",
            syntax.IsClass ? System.AttributeTargets.Class : System.AttributeTargets.Struct));

        if (hasAttributeSugar && syntax.IsClass)
        {
            // Phase 4 of #141 / ADR-0047 §5: tag the class so the emitter
            // overrides its CLR base type to System.Attribute.
            structSymbol.SetIsAttributeClass();
        }

        if (importedBaseType != null)
        {
            // Issue #296: record the imported CLR base class so the emitter
            // writes it as the TypeDef base type, chains the generated ctor to
            // the CLR base's parameterless ctor, and member lookup walks into
            // the CLR base for inherited members.
            structSymbol.SetImportedBaseType(importedBaseType);
        }

        // Issue #306: bind and resolve an explicit base-constructor initializer
        // (`: Base(args)`). The arguments are bound in a scope that exposes the
        // primary-constructor parameters so they can be forwarded to the base.
        BindBaseConstructorInitializer(syntax, structSymbol, baseClassSymbol, importedBaseType, primaryCtorParameters);

        if (!scope.TryDeclareTypeAlias(name, structSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }

        // Collect existing member names for duplicate detection across fields,
        // methods, and properties.
        var existingNames = new HashSet<string>();
        foreach (var f in structSymbol.Fields)
        {
            existingNames.Add(f.Name);
        }

        // Phase 3.B.3 sub-step 2b: bind methods declared inside the class body.
        // Methods are only legal on `class` types (struct methods rejected by
        // the parser already). Each method becomes a FunctionSymbol with
        // ReceiverType = structSymbol; method bodies are bound later by
        // BindProgram by walking StructSymbol.Methods.
        if (syntax.IsClass && !syntax.Methods.IsDefaultOrEmpty)
        {
            var methodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
            foreach (var methodSyntax in syntax.Methods)
            {
                var methodName = methodSyntax.Identifier.Text;
                if (!existingNames.Add(methodName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(methodSyntax.Identifier.Location, methodName);
                    continue;
                }

                // Issue #312 / ADR-0020: a method may declare its own generic
                // type-parameter list (`func M[T](...) T`). Bind it first and
                // seed it into the binding scope — merged with any enclosing
                // class type parameters — so the method's parameter types,
                // return type, and (later) body can reference `T`. The seeding
                // is unwound at the end of each iteration so one method's type
                // parameters never leak into the next or the surrounding type.
                var methodTypeParameters = BindTypeParameterList(methodSyntax.TypeParameterList);
                var enclosingTypeParameters = currentTypeParameters;
                if (!methodTypeParameters.IsDefaultOrEmpty)
                {
                    currentTypeParameters = enclosingTypeParameters == null
                        ? new Dictionary<string, TypeParameterSymbol>()
                        : new Dictionary<string, TypeParameterSymbol>(enclosingTypeParameters);
                    foreach (var tp in methodTypeParameters)
                    {
                        currentTypeParameters[tp.Name] = tp;
                    }
                }

                try
                {
                    var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
                    var seenParameterNames = new HashSet<string>();
                    foreach (var parameterSyntax in methodSyntax.Parameters)
                    {
                        var parameterName = parameterSyntax.Identifier.Text;
                        var parameterType = BindTypeClause(parameterSyntax.Type);
                        if (parameterSyntax.IsVariadic)
                        {
                            Diagnostics.ReportVariadicParameterNotSupportedHere(parameterSyntax.Location, parameterName);
                        }

                        if (!seenParameterNames.Add(parameterName))
                        {
                            Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                        }
                        else
                        {
                            parameters.Add(new ParameterSymbol(parameterName, parameterType, declaringSyntax: parameterSyntax.Identifier));
                        }
                    }

                    var returnType = BindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void;
                    var methodAccessibility = ResolveAccessibility(methodSyntax.AccessibilityModifier);
                    var methodParameters = parameters.ToImmutable();

                    // Phase 3.B.3 sub-step 3: open/override validation against
                    // base class chain per ADR-0017.
                    FunctionSymbol overriddenMethod = null;
                    if (methodSyntax.IsOverride)
                    {
                        if (structSymbol.BaseClass == null || !structSymbol.BaseClass.TryGetMethodIncludingInherited(methodName, out var baseMethod))
                        {
                            Diagnostics.ReportNoBaseMethodToOverride(methodSyntax.Identifier.Location, methodName);
                        }
                        else if (!baseMethod.IsOpen)
                        {
                            Diagnostics.ReportOverrideOfSealedMethod(methodSyntax.Identifier.Location, methodName);
                        }
                        else if (!SignaturesMatch(baseMethod, methodParameters, returnType))
                        {
                            Diagnostics.ReportOverrideSignatureMismatch(methodSyntax.Identifier.Location, methodName);
                        }
                        else
                        {
                            overriddenMethod = baseMethod;
                        }
                    }
                    else if (structSymbol.BaseClass != null
                        && structSymbol.BaseClass.TryGetMethodIncludingInherited(methodName, out var shadowed)
                        && shadowed.IsOpen)
                    {
                        // Method shadows an overridable base method without `override`.
                        Diagnostics.ReportMissingOverride(methodSyntax.Identifier.Location, shadowed.ReceiverType.Name, methodName);
                    }

                    var methodSymbol = new FunctionSymbol(
                        methodName,
                        methodParameters,
                        returnType,
                        methodSyntax,
                        package,
                        methodAccessibility,
                        receiverType: structSymbol,
                        isOpen: methodSyntax.IsOpen,
                        isOverride: methodSyntax.IsOverride);
                    methodSymbol.OverriddenMethod = overriddenMethod;
                    methodSymbol.TypeParameters = methodTypeParameters;

                    if (!methodSyntax.Annotations.IsDefaultOrEmpty)
                    {
                        var methodAttributes = BindAttributes(
                            methodSyntax.Annotations,
                            AttributeTargetKind.Method,
                            FunctionDeclarationAllowedTargets,
                            "a method declaration",
                            System.AttributeTargets.Method);
                        methodSymbol.SetAttributes(methodAttributes);
                    }

                    methodsBuilder.Add(methodSymbol);
                }
                finally
                {
                    currentTypeParameters = enclosingTypeParameters;
                }
            }

            structSymbol.SetMethods(methodsBuilder.ToImmutable());
        }

        // ADR-0051: bind property declarations.
        if (!syntax.Properties.IsDefaultOrEmpty)
        {
            var propertiesBuilder = ImmutableArray.CreateBuilder<PropertySymbol>();
            foreach (var propSyntax in syntax.Properties)
            {
                var propName = propSyntax.Identifier.Text;

                // Check for duplicate names (fields + methods + other properties)
                if (!existingNames.Add(propName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName);
                    continue;
                }

                var propType = BindTypeClause(propSyntax.Type);
                if (propType == null)
                {
                    continue;
                }

                var propAccessibility = ResolveAccessibility(propSyntax.AccessibilityModifier);

                // Determine accessor presence
                bool hasGetter = true;
                bool hasSetter;
                bool isAutoProperty;
                string setterParamName = "value";

                if (propSyntax.OpenBraceToken == null)
                {
                    // Bare auto-property: prop Name Type
                    hasSetter = true;
                    isAutoProperty = true;
                }
                else
                {
                    // Has body — check accessors
                    var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter);
                    hasGetter = getAccessor != null || propSyntax.Accessors.IsDefaultOrEmpty;
                    hasSetter = setAccessor != null;

                    if (setAccessor != null && setAccessor.ParameterIdentifier != null)
                    {
                        setterParamName = setAccessor.ParameterIdentifier.Text;
                    }

                    // Auto-property if accessors have no bodies
                    isAutoProperty = (getAccessor == null || getAccessor.Body == null)
                                  && (setAccessor == null || setAccessor.Body == null)
                                  && propSyntax.Accessors.All(a => a.Body == null);
                }

                // Validate: auto-property not allowed on data struct
                if (isAutoProperty && syntax.IsData)
                {
                    Diagnostics.ReportAutoPropertyInDataStruct(propSyntax.Identifier.Location, propName);
                }

                // Validate: open only on open class
                bool isVirtual = propSyntax.OpenModifier != null;
                bool isOverride = propSyntax.OverrideModifier != null;

                if (isVirtual && !structSymbol.IsOpen)
                {
                    Diagnostics.ReportOpenMemberInNonOpenClass(propSyntax.OpenModifier.Location, propName);
                }

                // Validate: override needs base property
                PropertySymbol overriddenProperty = null;
                if (isOverride)
                {
                    if (structSymbol.BaseClass == null || !TryGetPropertyIncludingInherited(structSymbol.BaseClass, propName, out var baseProp))
                    {
                        Diagnostics.ReportNoBaseMethodToOverride(propSyntax.Identifier.Location, propName);
                    }
                    else if (!baseProp.IsVirtual && !baseProp.IsOverride)
                    {
                        Diagnostics.ReportOverrideOfSealedMethod(propSyntax.Identifier.Location, propName);
                    }
                    else
                    {
                        overriddenProperty = baseProp;
                    }
                }

                var propertySymbol = new PropertySymbol(
                    propName,
                    propType,
                    propAccessibility,
                    hasGetter,
                    hasSetter,
                    isAutoProperty,
                    isVirtual,
                    isOverride,
                    setterParamName);

                // Create backing field for auto-properties
                if (isAutoProperty && !syntax.IsData)
                {
                    var backingField = new FieldSymbol(
                        $"<{propName}>k__BackingField",
                        propType,
                        Accessibility.Private,
                        isReadOnly: !hasSetter);
                    propertySymbol.BackingField = backingField;
                }

                // Create FunctionSymbols for computed property accessors (ADR-0051).
                if (!isAutoProperty)
                {
                    var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter);

                    if (hasGetter && getAccessor?.Body != null)
                    {
                        var getterSymbol = new FunctionSymbol(
                            $"get_{propName}",
                            ImmutableArray<ParameterSymbol>.Empty,
                            propType,
                            declaration: null,
                            package,
                            propAccessibility,
                            receiverType: structSymbol,
                            isOpen: isVirtual,
                            isOverride: isOverride);
                        propertySymbol.GetterSymbol = getterSymbol;
                        propertySymbol.GetterBodySyntax = getAccessor.Body;
                    }

                    if (hasSetter && setAccessor?.Body != null)
                    {
                        var setterParam = new ParameterSymbol(setterParamName, propType);
                        var setterSymbol = new FunctionSymbol(
                            $"set_{propName}",
                            ImmutableArray.Create(setterParam),
                            TypeSymbol.Void,
                            declaration: null,
                            package,
                            propAccessibility,
                            receiverType: structSymbol,
                            isOpen: isVirtual,
                            isOverride: isOverride);
                        propertySymbol.SetterSymbol = setterSymbol;
                        propertySymbol.SetterBodySyntax = setAccessor.Body;
                    }
                }

                // Bind annotations
                if (!propSyntax.Annotations.IsDefaultOrEmpty)
                {
                    propertySymbol.SetAttributes(BindAttributes(
                        propSyntax.Annotations,
                        AttributeTargetKind.Property,
                        PropertyDeclarationAllowedTargets,
                        "a property declaration",
                        System.AttributeTargets.Property));
                }

                propertiesBuilder.Add(propertySymbol);
            }

            structSymbol.SetProperties(propertiesBuilder.ToImmutable());
        }

        // ADR-0052: bind event declarations.
        if (!syntax.Events.IsDefaultOrEmpty)
        {
            var eventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>();
            foreach (var eventSyntax in syntax.Events)
            {
                var eventName = eventSyntax.Identifier.Text;

                // Check for duplicate names
                if (!existingNames.Add(eventName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName);
                    continue;
                }

                var handlerType = BindTypeClause(eventSyntax.Type);
                if (handlerType == null)
                {
                    continue;
                }

                var eventAccessibility = ResolveAccessibility(eventSyntax.AccessibilityModifier);
                bool isFieldLike = eventSyntax.OpenBraceToken == null;
                bool isVirtual = eventSyntax.OpenModifier != null;
                bool isOverride = eventSyntax.OverrideModifier != null;

                // Validate: open only on open class
                if (isVirtual && !structSymbol.IsOpen)
                {
                    Diagnostics.ReportOpenMemberInNonOpenClass(eventSyntax.OpenModifier.Location, eventName);
                }

                var eventSymbol = new EventSymbol(
                    eventName,
                    handlerType,
                    eventAccessibility,
                    isFieldLike,
                    isVirtual,
                    isOverride);

                // Create backing field for field-like events
                if (isFieldLike)
                {
                    var backingField = new FieldSymbol(
                        eventName,
                        handlerType,
                        Accessibility.Private,
                        isReadOnly: false);
                    eventSymbol.BackingField = backingField;
                }
                else
                {
                    // Explicit accessors — store body syntax
                    var addAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsAdd);
                    var removeAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRemove);
                    var raiseAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRaise);

                    if (addAccessor?.Body != null)
                    {
                        eventSymbol.AddBodySyntax = addAccessor.Body;
                    }

                    if (removeAccessor?.Body != null)
                    {
                        eventSymbol.RemoveBodySyntax = removeAccessor.Body;
                    }

                    if (raiseAccessor?.Body != null)
                    {
                        eventSymbol.RaiseBodySyntax = raiseAccessor.Body;
                    }
                }

                // Create add/remove method symbols
                var handlerParam = new ParameterSymbol("value", handlerType);
                eventSymbol.AddMethodSymbol = new FunctionSymbol(
                    $"add_{eventName}",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    eventAccessibility,
                    receiverType: structSymbol,
                    isOpen: isVirtual,
                    isOverride: isOverride) { IsSpecialName = true };
                eventSymbol.RemoveMethodSymbol = new FunctionSymbol(
                    $"remove_{eventName}",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    eventAccessibility,
                    receiverType: structSymbol,
                    isOpen: isVirtual,
                    isOverride: isOverride) { IsSpecialName = true };

                // Issue #257: create raise method symbol if raise accessor is present.
                if (eventSyntax.Accessors.Any(a => a.IsRaise))
                {
                    var raiseParams = ImmutableArray<ParameterSymbol>.Empty;
                    if (handlerType is FunctionTypeSymbol fnType)
                    {
                        var builder = ImmutableArray.CreateBuilder<ParameterSymbol>(fnType.ParameterTypes.Length);
                        for (int pi = 0; pi < fnType.ParameterTypes.Length; pi++)
                        {
                            builder.Add(new ParameterSymbol($"arg{pi}", fnType.ParameterTypes[pi]));
                        }

                        raiseParams = builder.ToImmutable();
                    }

                    eventSymbol.RaiseMethodSymbol = new FunctionSymbol(
                        $"raise_{eventName}",
                        raiseParams,
                        TypeSymbol.Void,
                        declaration: null,
                        package,
                        eventAccessibility,
                        receiverType: structSymbol,
                        isOpen: isVirtual,
                        isOverride: isOverride) { IsSpecialName = true };
                }

                // Bind annotations
                if (!eventSyntax.Annotations.IsDefaultOrEmpty)
                {
                    eventSymbol.SetAttributes(BindAttributes(
                        eventSyntax.Annotations,
                        AttributeTargetKind.Event,
                        EventDeclarationAllowedTargets,
                        "an event declaration",
                        System.AttributeTargets.Event));
                }

                eventsBuilder.Add(eventSymbol);
            }

            structSymbol.SetEvents(eventsBuilder.ToImmutable());
        }

        // ADR-0053: bind members declared inside the optional `shared { … }` block
        // as static members on the struct/class symbol.
        if (syntax.SharedBlock != null)
        {
            // Static fields
            var staticFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
            var initializersBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
            foreach (var fieldSyntax in syntax.SharedBlock.Fields)
            {
                var fieldName = fieldSyntax.Identifier.Text;
                if (!existingNames.Add(fieldName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName);
                    continue;
                }

                var fieldType = BindTypeClause(fieldSyntax.Type);
                if (fieldType == null)
                {
                    continue;
                }

                var fieldAccessibility = ResolveAccessibility(fieldSyntax.AccessibilityModifier);
                var fieldSymbol = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: false, isStatic: true);

                if (!fieldSyntax.Annotations.IsDefaultOrEmpty)
                {
                    fieldSymbol.SetAttributes(BindAttributes(
                        fieldSyntax.Annotations,
                        AttributeTargetKind.Field,
                        FieldDeclarationAllowedTargets,
                        "a field declaration",
                        System.AttributeTargets.Field));
                }

                // Issue #262: bind the initializer expression if present.
                if (fieldSyntax.Initializer != null)
                {
                    var boundInit = BindExpression(fieldSyntax.Initializer);
                    var convertedInit = BindConversion(fieldSyntax.Initializer.Location, boundInit, fieldType);
                    initializersBuilder[fieldSymbol] = convertedInit;
                }

                staticFieldsBuilder.Add(fieldSymbol);
            }

            structSymbol.SetStaticFields(staticFieldsBuilder.ToImmutable());
            if (initializersBuilder.Count > 0)
            {
                structSymbol.SetStaticFieldInitializers(initializersBuilder.ToImmutable());
            }

            // Static methods
            var staticMethodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
            foreach (var methodSyntax in syntax.SharedBlock.Methods)
            {
                var methodName = methodSyntax.Identifier.Text;
                if (!existingNames.Add(methodName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(methodSyntax.Identifier.Location, methodName);
                    continue;
                }

                // Issue #312 / ADR-0020: support generic static methods too.
                var methodTypeParameters = BindTypeParameterList(methodSyntax.TypeParameterList);
                var enclosingTypeParameters = currentTypeParameters;
                if (!methodTypeParameters.IsDefaultOrEmpty)
                {
                    currentTypeParameters = enclosingTypeParameters == null
                        ? new Dictionary<string, TypeParameterSymbol>()
                        : new Dictionary<string, TypeParameterSymbol>(enclosingTypeParameters);
                    foreach (var tp in methodTypeParameters)
                    {
                        currentTypeParameters[tp.Name] = tp;
                    }
                }

                try
                {
                    var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
                    var seenParameterNames = new HashSet<string>();
                    foreach (var parameterSyntax in methodSyntax.Parameters)
                    {
                        var parameterName = parameterSyntax.Identifier.Text;
                        var parameterType = BindTypeClause(parameterSyntax.Type);
                        if (parameterSyntax.IsVariadic)
                        {
                            Diagnostics.ReportVariadicParameterNotSupportedHere(parameterSyntax.Location, parameterName);
                        }

                        if (!seenParameterNames.Add(parameterName))
                        {
                            Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                        }
                        else
                        {
                            parameters.Add(new ParameterSymbol(parameterName, parameterType, declaringSyntax: parameterSyntax.Identifier));
                        }
                    }

                    var returnType = BindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void;
                    var methodAccessibility = ResolveAccessibility(methodSyntax.AccessibilityModifier);

                    var methodSymbol = new FunctionSymbol(
                        methodName,
                        parameters.ToImmutable(),
                        returnType,
                        methodSyntax,
                        package,
                        methodAccessibility,
                        receiverType: null);
                    methodSymbol.IsStatic = true;
                    methodSymbol.StaticOwnerType = structSymbol;
                    methodSymbol.TypeParameters = methodTypeParameters;

                    if (!methodSyntax.Annotations.IsDefaultOrEmpty)
                    {
                        var methodAttributes = BindAttributes(
                            methodSyntax.Annotations,
                            AttributeTargetKind.Method,
                            FunctionDeclarationAllowedTargets,
                            "a method declaration",
                            System.AttributeTargets.Method);
                        methodSymbol.SetAttributes(methodAttributes);
                    }

                    staticMethodsBuilder.Add(methodSymbol);
                }
                finally
                {
                    currentTypeParameters = enclosingTypeParameters;
                }
            }

            structSymbol.SetStaticMethods(staticMethodsBuilder.ToImmutable());

            // Static properties
            var staticPropertiesBuilder = ImmutableArray.CreateBuilder<PropertySymbol>();
            foreach (var propSyntax in syntax.SharedBlock.Properties)
            {
                var propName = propSyntax.Identifier.Text;
                if (!existingNames.Add(propName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName);
                    continue;
                }

                var propType = BindTypeClause(propSyntax.Type);
                if (propType == null)
                {
                    continue;
                }

                var propAccessibility = ResolveAccessibility(propSyntax.AccessibilityModifier);
                bool hasGetter = true;
                bool hasSetter;
                bool isAutoProperty;
                string setterParamName = "value";

                if (propSyntax.OpenBraceToken == null)
                {
                    hasSetter = true;
                    isAutoProperty = true;
                }
                else
                {
                    var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter);
                    hasGetter = getAccessor != null || propSyntax.Accessors.IsDefaultOrEmpty;
                    hasSetter = setAccessor != null;

                    if (setAccessor != null && setAccessor.ParameterIdentifier != null)
                    {
                        setterParamName = setAccessor.ParameterIdentifier.Text;
                    }

                    isAutoProperty = (getAccessor == null || getAccessor.Body == null)
                                  && (setAccessor == null || setAccessor.Body == null)
                                  && propSyntax.Accessors.All(a => a.Body == null);
                }

                var propertySymbol = new PropertySymbol(
                    propName,
                    propType,
                    propAccessibility,
                    hasGetter,
                    hasSetter,
                    isAutoProperty,
                    isVirtual: false,
                    isOverride: false,
                    setterParamName,
                    isStatic: true);

                if (isAutoProperty)
                {
                    var backingField = new FieldSymbol(
                        $"<{propName}>k__BackingField",
                        propType,
                        Accessibility.Private,
                        isReadOnly: !hasSetter,
                        isStatic: true);
                    propertySymbol.BackingField = backingField;
                }

                // Issue #263: create FunctionSymbols for computed static property accessors.
                if (!isAutoProperty)
                {
                    var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter);

                    if (hasGetter && getAccessor?.Body != null)
                    {
                        var getterSymbol = new FunctionSymbol(
                            $"get_{propName}",
                            ImmutableArray<ParameterSymbol>.Empty,
                            propType,
                            declaration: null,
                            package,
                            propAccessibility,
                            receiverType: null);
                        getterSymbol.IsStatic = true;
                        getterSymbol.StaticOwnerType = structSymbol;
                        propertySymbol.GetterSymbol = getterSymbol;
                        propertySymbol.GetterBodySyntax = getAccessor.Body;
                    }

                    if (hasSetter && setAccessor?.Body != null)
                    {
                        var setterParam = new ParameterSymbol(setterParamName, propType);
                        var setterSymbol = new FunctionSymbol(
                            $"set_{propName}",
                            ImmutableArray.Create(setterParam),
                            TypeSymbol.Void,
                            declaration: null,
                            package,
                            propAccessibility,
                            receiverType: null);
                        setterSymbol.IsStatic = true;
                        setterSymbol.StaticOwnerType = structSymbol;
                        propertySymbol.SetterSymbol = setterSymbol;
                        propertySymbol.SetterBodySyntax = setAccessor.Body;
                    }
                }

                if (!propSyntax.Annotations.IsDefaultOrEmpty)
                {
                    propertySymbol.SetAttributes(BindAttributes(
                        propSyntax.Annotations,
                        AttributeTargetKind.Property,
                        PropertyDeclarationAllowedTargets,
                        "a property declaration",
                        System.AttributeTargets.Property));
                }

                staticPropertiesBuilder.Add(propertySymbol);
            }

            structSymbol.SetStaticProperties(staticPropertiesBuilder.ToImmutable());

            // Static events
            var staticEventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>();
            foreach (var eventSyntax in syntax.SharedBlock.Events)
            {
                var eventName = eventSyntax.Identifier.Text;
                if (!existingNames.Add(eventName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName);
                    continue;
                }

                var handlerType = BindTypeClause(eventSyntax.Type);
                if (handlerType == null)
                {
                    continue;
                }

                var eventAccessibility = ResolveAccessibility(eventSyntax.AccessibilityModifier);
                bool isFieldLike = eventSyntax.OpenBraceToken == null;

                var eventSymbol = new EventSymbol(
                    eventName,
                    handlerType,
                    eventAccessibility,
                    isFieldLike,
                    isVirtual: false,
                    isOverride: false,
                    isStatic: true);

                if (isFieldLike)
                {
                    var backingField = new FieldSymbol(
                        eventName,
                        handlerType,
                        Accessibility.Private,
                        isReadOnly: false,
                        isStatic: true);
                    eventSymbol.BackingField = backingField;
                }
                else
                {
                    // Issue #257: store explicit accessor bodies for static events.
                    var addAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsAdd);
                    var removeAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRemove);
                    var raiseAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRaise);

                    if (addAccessor?.Body != null)
                    {
                        eventSymbol.AddBodySyntax = addAccessor.Body;
                    }

                    if (removeAccessor?.Body != null)
                    {
                        eventSymbol.RemoveBodySyntax = removeAccessor.Body;
                    }

                    if (raiseAccessor?.Body != null)
                    {
                        eventSymbol.RaiseBodySyntax = raiseAccessor.Body;
                    }
                }

                var handlerParam = new ParameterSymbol("value", handlerType);
                eventSymbol.AddMethodSymbol = new FunctionSymbol(
                    $"add_{eventName}",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    eventAccessibility,
                    receiverType: null) { IsSpecialName = true };
                eventSymbol.AddMethodSymbol.IsStatic = true;
                eventSymbol.RemoveMethodSymbol = new FunctionSymbol(
                    $"remove_{eventName}",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    eventAccessibility,
                    receiverType: null) { IsSpecialName = true };
                eventSymbol.RemoveMethodSymbol.IsStatic = true;

                // Issue #257: create raise method symbol if raise accessor is present.
                if (eventSyntax.Accessors.Any(a => a.IsRaise))
                {
                    var raiseParams = ImmutableArray<ParameterSymbol>.Empty;
                    if (handlerType is FunctionTypeSymbol fnType)
                    {
                        var builder = ImmutableArray.CreateBuilder<ParameterSymbol>(fnType.ParameterTypes.Length);
                        for (int pi = 0; pi < fnType.ParameterTypes.Length; pi++)
                        {
                            builder.Add(new ParameterSymbol($"arg{pi}", fnType.ParameterTypes[pi]));
                        }

                        raiseParams = builder.ToImmutable();
                    }

                    eventSymbol.RaiseMethodSymbol = new FunctionSymbol(
                        $"raise_{eventName}",
                        raiseParams,
                        TypeSymbol.Void,
                        declaration: null,
                        package,
                        eventAccessibility,
                        receiverType: null) { IsSpecialName = true };
                    eventSymbol.RaiseMethodSymbol.IsStatic = true;
                }

                if (!eventSyntax.Annotations.IsDefaultOrEmpty)
                {
                    eventSymbol.SetAttributes(BindAttributes(
                        eventSyntax.Annotations,
                        AttributeTargetKind.Event,
                        EventDeclarationAllowedTargets,
                        "an event declaration",
                        System.AttributeTargets.Event));
                }

                staticEventsBuilder.Add(eventSymbol);
            }

            structSymbol.SetStaticEvents(staticEventsBuilder.ToImmutable());
        }

        // Phase 3.B.4: validate interface implementation. Walks each
        // implemented interface and confirms the class (including inherited
        // methods) provides a same-name, same-signature method. The check
        // itself is deferred (see `VerifyInterfaceImplementations`) until
        // after interface method signatures have been bound, since
        // interface methods may forward-reference user struct/class types.
        if (implementedInterfaces.Count > 0)
        {
            structSymbol.SetInterfaces(implementedInterfaces.ToImmutable());
            foreach (var iface in implementedInterfaces)
            {
                // Phase 3.B.5: a `sealed` interface restricts implementors
                // to the same package as the interface itself.
                if (iface.IsSealed && !string.Equals(iface.PackageName ?? string.Empty, structSymbol.PackageName ?? string.Empty, System.StringComparison.Ordinal))
                {
                    Diagnostics.ReportSealedInterfaceImplementorOutsidePackage(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iface.PackageName ?? string.Empty);
                }
            }

            pendingInterfaceImplementationChecks.Add((syntax, structSymbol));
        }

        // Issue #306: bind standalone user-defined constructors (`init(...)`).
        BindConstructorDeclarations(syntax, structSymbol, package, baseClassSymbol, importedBaseType);
    }

    private void VerifyInterfaceImplementations()
    {
        foreach (var (syntax, structSymbol) in pendingInterfaceImplementationChecks)
        {
            foreach (var iface in structSymbol.Interfaces)
            {
                foreach (var imethod in iface.Methods)
                {
                    if (!structSymbol.TryGetMethodIncludingInherited(imethod.Name, out var impl)
                        || !SignaturesMatch(imethod, GetCallableParameters(impl), impl.Type))
                    {
                        Diagnostics.ReportInterfaceMethodNotImplemented(
                            syntax.Identifier.Location,
                            structSymbol.Name,
                            iface.Name,
                            imethod.Name);
                    }
                }

                // ADR-0051: verify property requirements.
                foreach (var iprop in iface.Properties)
                {
                    var found = false;
                    foreach (var implProp in structSymbol.Properties)
                    {
                        if (implProp.Name == iprop.Name)
                        {
                            if (iprop.HasGetter && !implProp.HasGetter)
                            {
                                Diagnostics.ReportInterfaceMethodNotImplemented(
                                    syntax.Identifier.Location,
                                    structSymbol.Name,
                                    iface.Name,
                                    iprop.Name + " (getter)");
                            }

                            if (iprop.HasSetter && !implProp.HasSetter)
                            {
                                Diagnostics.ReportInterfaceMethodNotImplemented(
                                    syntax.Identifier.Location,
                                    structSymbol.Name,
                                    iface.Name,
                                    iprop.Name + " (setter)");
                            }

                            found = true;
                            break;
                        }
                    }

                    if (!found)
                    {
                        Diagnostics.ReportInterfaceMethodNotImplemented(
                            syntax.Identifier.Location,
                            structSymbol.Name,
                            iface.Name,
                            iprop.Name);
                    }
                }
            }
        }
    }

    private static bool TryGetPropertyIncludingInherited(StructSymbol type, string name, out PropertySymbol property)
    {
        var current = type;
        while (current != null)
        {
            foreach (var p in current.Properties)
            {
                if (p.Name == name)
                {
                    property = p;
                    return true;
                }
            }

            current = current.BaseClass;
        }

        property = null;
        return false;
    }

    private InterfaceSymbol DeclareInterfaceSymbol(InterfaceDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;
        var accessibility = ResolveAccessibility(syntax.AccessibilityModifier);
        var interfaceSymbol = new InterfaceSymbol(name, accessibility, syntax, package.Name);
        interfaceSymbol.SetAttributes(BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            TypeDeclarationAllowedTargets,
            "an interface declaration",
            System.AttributeTargets.Interface));

        // Phase 4.3c / ADR-0020: bind type parameters at declaration time so
        // method-signature binding (which happens later) can resolve them.
        var typeParameters = BindTypeParameterList(syntax.TypeParameterList);
        if (!typeParameters.IsDefaultOrEmpty)
        {
            interfaceSymbol.SetTypeParameters(typeParameters);
        }

        if (!scope.TryDeclareTypeAlias(name, interfaceSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return null;
        }

        return interfaceSymbol;
    }

    private void BindInterfaceDeclaration(InterfaceDeclarationSyntax syntax, PackageSymbol package)
    {
        var declared = DeclareInterfaceSymbol(syntax, package);
        if (declared != null)
        {
            BindInterfaceMembers(syntax, declared, package);
        }
    }

    private void BindInterfaceMembers(InterfaceDeclarationSyntax syntax, InterfaceSymbol interfaceSymbol, PackageSymbol package)
    {
        // Phase 4.3c: push the interface's type parameters so that method
        // signatures can reference them.
        var previousTypeParameters = currentTypeParameters;
        if (!interfaceSymbol.TypeParameters.IsDefaultOrEmpty)
        {
            currentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
            foreach (var tp in interfaceSymbol.TypeParameters)
            {
                currentTypeParameters[tp.Name] = tp;
            }
        }

        try
        {
            BindInterfaceMembersCore(syntax, interfaceSymbol, package);
        }
        finally
        {
            currentTypeParameters = previousTypeParameters;
        }
    }

    private void BindInterfaceMembersCore(InterfaceDeclarationSyntax syntax, InterfaceSymbol interfaceSymbol, PackageSymbol package)
    {
        var methodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        var seenNames = new HashSet<string>();
        foreach (var methodSyntax in syntax.Methods)
        {
            var methodName = methodSyntax.Identifier.Text;
            if (!seenNames.Add(methodName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(methodSyntax.Identifier.Location, methodName);
                continue;
            }

            var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
            var seenParameterNames = new HashSet<string>();
            foreach (var parameterSyntax in methodSyntax.Parameters)
            {
                var parameterName = parameterSyntax.Identifier.Text;
                var parameterType = BindTypeClause(parameterSyntax.Type);
                if (parameterSyntax.IsVariadic)
                {
                    Diagnostics.ReportVariadicParameterNotSupportedHere(parameterSyntax.Location, parameterName);
                }

                if (!seenParameterNames.Add(parameterName))
                {
                    Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                }
                else
                {
                    parameters.Add(new ParameterSymbol(parameterName, parameterType, declaringSyntax: parameterSyntax.Identifier));
                }
            }

            var returnType = BindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void;
            var methodSymbol = new FunctionSymbol(
                methodName,
                parameters.ToImmutable(),
                returnType,
                methodSyntax,
                package,
                Accessibility.Public,
                receiverType: null);
            methodsBuilder.Add(methodSymbol);
        }

        interfaceSymbol.SetMethods(methodsBuilder.ToImmutable());

        // ADR-0051: bind interface property declarations.
        if (!syntax.Properties.IsDefaultOrEmpty)
        {
            var propertiesBuilder = ImmutableArray.CreateBuilder<PropertySymbol>();
            foreach (var propSyntax in syntax.Properties)
            {
                var propName = propSyntax.Identifier.Text;
                if (!seenNames.Add(propName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName);
                    continue;
                }

                var propType = BindTypeClause(propSyntax.Type);
                if (propType == null)
                {
                    continue;
                }

                bool hasGetter = true;
                bool hasSetter = false;

                if (propSyntax.OpenBraceToken != null)
                {
                    hasGetter = propSyntax.Accessors.Any(a => a.IsGetter);
                    hasSetter = propSyntax.Accessors.Any(a => a.IsSetter);
                    if (!hasGetter && !hasSetter)
                    {
                        hasGetter = true;
                        hasSetter = true;
                    }
                }
                else
                {
                    // Bare: prop Name Type in interface = get + set
                    hasSetter = true;
                }

                var propSymbol = new PropertySymbol(
                    propName,
                    propType,
                    Accessibility.Public,
                    hasGetter,
                    hasSetter,
                    isAutoProperty: false,
                    isVirtual: false,
                    isOverride: false);

                propertiesBuilder.Add(propSymbol);
            }

            interfaceSymbol.SetProperties(propertiesBuilder.ToImmutable());
        }

        // ADR-0052: bind interface event declarations.
        if (!syntax.Events.IsDefaultOrEmpty)
        {
            var eventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>();
            foreach (var eventSyntax in syntax.Events)
            {
                var eventName = eventSyntax.Identifier.Text;
                if (!seenNames.Add(eventName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName);
                    continue;
                }

                var handlerType = BindTypeClause(eventSyntax.Type);
                if (handlerType == null)
                {
                    continue;
                }

                var eventSymbol = new EventSymbol(
                    eventName,
                    handlerType,
                    Accessibility.Public,
                    isFieldLike: false,
                    isVirtual: false,
                    isOverride: false);

                eventsBuilder.Add(eventSymbol);
            }

            interfaceSymbol.SetEvents(eventsBuilder.ToImmutable());
        }

        // Phase 4.3c / ADR-0021: variance position checking. Walk each method's
        // parameter types (contravariant position) and return type (covariant
        // position). An `out T` may only appear in covariant position; an
        // `in T` may only appear in contravariant position.
        if (!interfaceSymbol.TypeParameters.IsDefaultOrEmpty)
        {
            for (var i = 0; i < interfaceSymbol.Methods.Length; i++)
            {
                var m = interfaceSymbol.Methods[i];
                var methodSyntax = syntax.Methods[i];
                CheckVariancePosition(m.Type, isOutput: true, methodSyntax.Type?.Location ?? methodSyntax.Identifier.Location);
                for (var p = 0; p < m.Parameters.Length; p++)
                {
                    var paramSyntax = methodSyntax.Parameters[p];
                    CheckVariancePosition(m.Parameters[p].Type, isOutput: false, paramSyntax.Type?.Location ?? paramSyntax.Location);
                }
            }
        }
    }

    private void CheckVariancePosition(TypeSymbol type, bool isOutput, TextLocation location)
    {
        if (type is TypeParameterSymbol tp)
        {
            if (tp.Variance == TypeParameterVariance.Out && !isOutput)
            {
                Diagnostics.ReportTypeParameterVariancePositionViolation(location, tp.Name, "out", "input");
            }
            else if (tp.Variance == TypeParameterVariance.In && isOutput)
            {
                Diagnostics.ReportTypeParameterVariancePositionViolation(location, tp.Name, "in", "output");
            }

            return;
        }

        if (type is SliceTypeSymbol s)
        {
            CheckVariancePosition(s.ElementType, isOutput, location);
            return;
        }

        if (type is ArrayTypeSymbol a)
        {
            CheckVariancePosition(a.ElementType, isOutput, location);
            return;
        }

        if (type is NullableTypeSymbol n)
        {
            CheckVariancePosition(n.UnderlyingType, isOutput, location);
            return;
        }
    }

    private void BindFunctionDeclaration(FunctionDeclarationSyntax syntax, PackageSymbol package)
    {
        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();

        var seenParameterNames = new HashSet<string>();

        // Phase 4.1 / ADR-0020: bind generic type parameters first so that
        // BindTypeClause can find them when binding parameter / return types.
        var typeParameters = BindTypeParameterList(syntax.TypeParameterList);
        var previousTypeParameters = currentTypeParameters;
        if (!typeParameters.IsDefaultOrEmpty)
        {
            currentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
            foreach (var tp in typeParameters)
            {
                currentTypeParameters[tp.Name] = tp;
            }
        }

        try
        {
            // Phase 3.B.6 / ADR-0019 and Phase 6.4 / ADR-0024: receiver
            // clauses become parameters[0]. Same-package struct/class receivers
            // are methods; all other valid receivers remain extension functions.
            TypeSymbol receiverType = null;
            ParameterSymbol explicitReceiverParameter = null;
            StructSymbol methodReceiverStruct = null;
            if (syntax.IsExtension)
            {
                var recvName = syntax.Receiver.Identifier.Text;
                receiverType = BindTypeClause(syntax.Receiver.Type);
                if (receiverType == null)
                {
                    receiverType = TypeSymbol.Error;
                }

                explicitReceiverParameter = new ParameterSymbol(recvName, receiverType, declaringSyntax: syntax.Receiver);
                seenParameterNames.Add(recvName);
                parameters.Add(explicitReceiverParameter);

                if (receiverType is StructSymbol receiverStruct && string.Equals(receiverStruct.PackageName, package.Name, StringComparison.Ordinal))
                {
                    methodReceiverStruct = receiverStruct.Definition ?? receiverStruct;
                }
                else if (IsSamePackageNonAggregateReceiver(syntax.Receiver.Type, receiverType, package))
                {
                    Diagnostics.ReportMethodReceiverMustBeStructOrClass(syntax.Receiver.Type.Location, receiverType.Name);
                    return;
                }
            }

            // Tracks the bound ParameterSymbol corresponding to each parameter
            // syntax position (null for duplicates) so per-parameter annotations
            // can be attached to the right symbol below.
            var parameterSymbolBySyntax = new ParameterSymbol[syntax.Parameters.Count];
            for (var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++)
            {
                var parameterSyntax = syntax.Parameters[pIndex];
                var parameterName = parameterSyntax.Identifier.Text;
                var parameterType = BindTypeClause(parameterSyntax.Type);
                if (!seenParameterNames.Add(parameterName))
                {
                    Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                }
                else
                {
                    // Phase 4.8: a `...T` parameter has type `[]T` for the body
                    // and must be the last parameter. Auto-packing of trailing
                    // arguments happens at the call site.
                    var isVariadic = parameterSyntax.IsVariadic;
                    if (isVariadic && parameterType != null && parameterType != TypeSymbol.Error)
                    {
                        parameterType = SliceTypeSymbol.Get(parameterType);
                    }

                    var parameter = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier);
                    parameters.Add(parameter);
                    parameterSymbolBySyntax[pIndex] = parameter;
                }
            }

            // Phase 4.8: validate `...T` appears only on the last syntactic parameter.
            for (var i = 0; i < syntax.Parameters.Count - 1; i++)
            {
                if (syntax.Parameters[i].IsVariadic)
                {
                    Diagnostics.ReportVariadicParameterMustBeLast(syntax.Parameters[i].Location, syntax.Parameters[i].Identifier.Text);
                }
            }

            // ADR-0041: bind the return type with async-aware alias resolution.
            var type = BindReturnTypeClause(syntax.Type, syntax.IsAsync) ?? TypeSymbol.Void;

            var accessibility = ResolveAccessibility(syntax.AccessibilityModifier);

            // Issue #141 / ADR-0047: resolve annotation lead-ins for this
            // declaration. We do this once per function regardless of whether
            // it is an extension, a method, or a free function — diagnostics
            // and the resulting bound-attribute list are identical.
            var functionAttributes = BindAttributes(
                syntax.Annotations,
                AttributeTargetKind.Method,
                FunctionDeclarationAllowedTargets,
                "a function declaration",
                System.AttributeTargets.Method);

            // Issue #176 / ADR-0047 §6: a function marked `@Conditional`
            // must return void. The CLR rule (matching C# CS0578) is that
            // conditional-method calls may be elided at the call site, which
            // is incompatible with a non-void result feeding the surrounding
            // expression. The attribute is still attached to the function
            // symbol so downstream tools see the user's intent and so the
            // call site still elides; the diagnostic is per-declaration.
            if (KnownAttributes.HasConditional(functionAttributes) && type != TypeSymbol.Void)
            {
                Diagnostics.ReportConditionalMethodMustReturnVoid(syntax.Identifier.Location, syntax.Identifier.Text);
            }

            // Per-parameter annotations: each ParameterSyntax owns its own
            // annotation list; the default target is `param`. Issue #170 /
            // ADR-0047 §3: the bound list is stored on the ParameterSymbol so
            // the emitter can emit a `CustomAttribute` row keyed to the
            // corresponding `Parameter` metadata handle.
            for (var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++)
            {
                var parameterSyntax = syntax.Parameters[pIndex];
                var paramAttrs = BindAttributes(
                    parameterSyntax.Annotations,
                    AttributeTargetKind.Param,
                    ParameterAllowedTargets,
                    "a parameter declaration",
                    System.AttributeTargets.Parameter);

                var parameterSymbol = parameterSymbolBySyntax[pIndex];
                if (parameterSymbol != null && !paramAttrs.IsDefaultOrEmpty)
                {
                    parameterSymbol.SetAttributes(paramAttrs);

                    // Issue #180 / ADR-0040: validate @EnumeratorCancellation.
                    // The attribute marks the cancellation-token parameter that
                    // the async-sequence rewriter threads through, so it is
                    // only meaningful when (a) the parameter's type is
                    // System.Threading.CancellationToken and (b) the enclosing
                    // function returns IAsyncEnumerable[T] (an `async sequence`).
                    // Diagnostics are reported per offending attribute; the
                    // attribute is still attached so downstream tooling can
                    // observe the user's intent.
                    var ecAttr = KnownAttributes.FindEnumeratorCancellation(paramAttrs);
                    if (ecAttr != null)
                    {
                        if (parameterSymbol.Type?.ClrType != typeof(System.Threading.CancellationToken))
                        {
                            Diagnostics.ReportEnumeratorCancellationWrongType(
                                parameterSyntax.Location,
                                parameterSymbol.Name,
                                parameterSymbol.Type?.Name ?? "?");
                        }
                        else if (!IsAsyncSequenceReturnType(type))
                        {
                            Diagnostics.ReportEnumeratorCancellationNotAsyncSequence(
                                parameterSyntax.Location,
                                parameterSymbol.Name);
                        }
                    }
                }
            }

            FunctionSymbol function;
            if (methodReceiverStruct != null)
            {
                var methodName = syntax.Identifier.Text;
                if (methodReceiverStruct.IsInline && IsInlineSynthesizedMemberName(methodName))
                {
                    Diagnostics.ReportInlineStructSynthesizedMemberConflict(syntax.Identifier.Location, methodReceiverStruct.Name, methodName);
                    return;
                }

                if (methodReceiverStruct.TryGetField(methodName, out _) || methodReceiverStruct.TryGetMethod(methodName, out _))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, methodName);
                    return;
                }

                function = new FunctionSymbol(
                    methodName,
                    parameters.ToImmutable(),
                    type,
                    syntax,
                    package,
                    accessibility,
                    methodReceiverStruct,
                    explicitReceiverParameter);
                function.TypeParameters = typeParameters;
                function.IsAsync = syntax.IsAsync || IsAsyncIteratorReturnType(type);
                function.SetAttributes(functionAttributes);
                methodReceiverStruct.AddMethods(ImmutableArray.Create(function));
                return;
            }

            function = new FunctionSymbol(syntax.Identifier.Text, parameters.ToImmutable(), type, syntax, package, accessibility);
            function.TypeParameters = typeParameters;
            function.IsAsync = syntax.IsAsync || IsAsyncIteratorReturnType(type);
            function.SetAttributes(functionAttributes);

            if (syntax.IsExtension)
            {
                function.IsExtension = true;
                function.ExtensionReceiverType = receiverType;
                if (function.Declaration.Identifier.Text != null && !scope.TryDeclareExtensionFunction(function))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, function.Name);
                }

                return;
            }

            if (function.Declaration.Identifier.Text != null && !scope.TryDeclareFunction(function))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, function.Name);
            }
        }
        finally
        {
            currentTypeParameters = previousTypeParameters;
        }
    }

    private static bool IsInlineSynthesizedMemberName(string methodName)
    {
        return methodName == "Equals" ||
            methodName == "GetHashCode" ||
            methodName == "ToString" ||
            methodName == "op_Equality" ||
            methodName == "op_Inequality" ||
            methodName == "Deconstruct";
    }

    private bool IsSamePackageNonAggregateReceiver(TypeClauseSyntax receiverSyntax, TypeSymbol receiverType, PackageSymbol package)
    {
        if (receiverType is InterfaceSymbol iface)
        {
            return string.Equals(iface.PackageName, package.Name, StringComparison.Ordinal);
        }

        if (receiverType is EnumSymbol enumSymbol)
        {
            return string.Equals(enumSymbol.PackageName, package.Name, StringComparison.Ordinal);
        }

        var receiverName = receiverSyntax?.Identifier?.Text;
        return receiverName != null
            && !IsPrimitiveTypeName(receiverName)
            && scope.TryLookupTypeAlias(receiverName, out var aliased)
            && ReferenceEquals(aliased, receiverType)
            && receiverType is not StructSymbol;
    }

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

    private ImmutableArray<TypeParameterSymbol> BindTypeParameterList(TypeParameterListSyntax syntax)
    {
        if (syntax == null)
        {
            return ImmutableArray<TypeParameterSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<TypeParameterSymbol>(syntax.Parameters.Count);
        var seen = new HashSet<string>();
        for (var i = 0; i < syntax.Parameters.Count; i++)
        {
            var p = syntax.Parameters[i];
            var name = p.Identifier.Text;
            if (!seen.Add(name))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(p.Identifier.Location, name);
            }

            var constraint = TypeParameterConstraint.Any;
            InterfaceSymbol interfaceConstraint = null;
            if (p.Constraint != null)
            {
                switch (p.Constraint.Text)
                {
                    case "any":
                        constraint = TypeParameterConstraint.Any;
                        break;
                    case "comparable":
                        constraint = TypeParameterConstraint.Comparable;
                        break;
                    default:
                        // Phase 4.2b / ADR-0020: a non-keyword constraint is treated as a
                        // sealed-interface bound. The interface must exist and be sealed
                        // (since open interfaces could be implemented by unknown future
                        // types, defeating the binder's purpose).
                        var resolved = LookupType(p.Constraint.Text);
                        if (resolved is InterfaceSymbol iface)
                        {
                            if (!iface.IsSealed)
                            {
                                Diagnostics.ReportInterfaceConstraintNotSealed(p.Constraint.Location, iface.Name);
                            }

                            interfaceConstraint = iface;
                        }
                        else
                        {
                            Diagnostics.ReportUndefinedType(p.Constraint.Location, p.Constraint.Text);
                        }

                        break;
                }
            }

            var variance = TypeParameterVariance.None;
            if (p.VarianceModifier != null)
            {
                variance = p.VarianceModifier.Text == "in" ? TypeParameterVariance.In : TypeParameterVariance.Out;
            }

            builder.Add(new TypeParameterSymbol(name, i, constraint, variance, interfaceConstraint));
        }

        return builder.MoveToImmutable();
    }

    private static bool SignaturesMatch(FunctionSymbol baseMethod, ImmutableArray<ParameterSymbol> derivedParams, TypeSymbol derivedReturnType)
    {
        if (baseMethod.Type != derivedReturnType)
        {
            return false;
        }

        var baseParams = GetCallableParameters(baseMethod);
        if (baseParams.Length != derivedParams.Length)
        {
            return false;
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (baseParams[i].Type != derivedParams[i].Type)
            {
                return false;
            }
        }

        return true;
    }

    private static ImmutableArray<ParameterSymbol> GetCallableParameters(FunctionSymbol method)
        => method.ExplicitReceiverParameter == null ? method.Parameters : method.Parameters.RemoveAt(0);

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

    private BoundStatement BindErrorStatement()
    {
        return new BoundExpressionStatement(null, new BoundErrorExpression(null));
    }

    private BoundStatement BindStatement(StatementSyntax syntax)
    {
        switch (syntax.Kind)
        {
            case SyntaxKind.CommentToken:
                // comments don't need to be bound
                return null;
            case SyntaxKind.BlockStatement:
                return BindBlockStatement((BlockStatementSyntax)syntax);
            case SyntaxKind.VariableDeclaration:
                return BindVariableDeclaration((VariableDeclarationSyntax)syntax);
            case SyntaxKind.IfStatement:
                return BindIfStatement((IfStatementSyntax)syntax);
            case SyntaxKind.ForInfiniteStatement:
                return BindForInfiniteStatement((ForInfiniteStatementSyntax)syntax);
            case SyntaxKind.ForEllipsisStatement:
                return BindForEllipsisStatement((ForEllipsisStatementSyntax)syntax);
            case SyntaxKind.ForConditionStatement:
                return BindForConditionStatement((ForConditionStatementSyntax)syntax);
            case SyntaxKind.ForClauseStatement:
                return BindForClauseStatement((ForClauseStatementSyntax)syntax);
            case SyntaxKind.ForRangeStatement:
                return BindForRangeStatement((ForRangeStatementSyntax)syntax);
            case SyntaxKind.BreakStatement:
                return BindBreakStatement((BreakStatementSyntax)syntax);
            case SyntaxKind.ContinueStatement:
                return BindContinueStatement((ContinueStatementSyntax)syntax);
            case SyntaxKind.ReturnStatement:
                return BindReturnStatement((ReturnStatementSyntax)syntax);
            case SyntaxKind.ExpressionStatement:
                return BindExpressionStatement((ExpressionStatementSyntax)syntax);
            case SyntaxKind.MultiAssignmentStatement:
                return BindMultiAssignmentStatement((MultiAssignmentStatementSyntax)syntax);
            case SyntaxKind.SwitchStatement:
                return BindSwitchStatement((SwitchStatementSyntax)syntax);
            case SyntaxKind.TryStatement:
                return BindTryStatement((TryStatementSyntax)syntax);
            case SyntaxKind.ThrowStatement:
                return BindThrowStatement((ThrowStatementSyntax)syntax);
            case SyntaxKind.UsingStatement:
                return BindUsingStatement((UsingStatementSyntax)syntax);
            case SyntaxKind.DeferStatement:
                return BindDeferStatement((DeferStatementSyntax)syntax);
            case SyntaxKind.GoStatement:
                return BindGoStatement((GoStatementSyntax)syntax);
            case SyntaxKind.ChannelSendStatement:
                return BindChannelSendStatement((ChannelSendStatementSyntax)syntax);
            case SyntaxKind.SelectStatement:
                return BindSelectStatement((SelectStatementSyntax)syntax);
            case SyntaxKind.ScopeStatement:
                return BindScopeStatement((ScopeStatementSyntax)syntax);
            case SyntaxKind.AwaitForRangeStatement:
                return BindAwaitForRangeStatement((AwaitForRangeStatementSyntax)syntax);
            case SyntaxKind.YieldStatement:
                return BindYieldStatement((YieldStatementSyntax)syntax);
            case SyntaxKind.TupleDeconstructionStatement:
                return BindTupleDeconstructionStatement((TupleDeconstructionStatementSyntax)syntax);
            case SyntaxKind.NamedDeconstructionStatement:
                return BindNamedDeconstructionStatement((NamedDeconstructionStatementSyntax)syntax);
            default:
                throw new Exception($"Unexpected syntax {syntax.Kind}");
        }
    }

    private BoundStatement BindBlockStatement(BlockStatementSyntax syntax)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        scope = new BoundScope(scope);

        BindBlockStatements(syntax.Statements, 0, statements);

        scope = scope.Parent;

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private void BindBlockStatements(ImmutableArray<StatementSyntax> statementSyntaxes, int startIndex, ImmutableArray<BoundStatement>.Builder statements)
    {
        // Issue #208: push a persistent narrowing frame for this statement list.
        // After each call statement whose method carries [MemberNotNull], the
        // named fields are added to this frame and remain narrowed for all
        // subsequent statements in the block (until assignment invalidates them).
        var memberNotNullFrame = new Dictionary<VariableSymbol, TypeSymbol>();
        narrowedVariables.Add(memberNotNullFrame);
        try
        {
            for (var i = startIndex; i < statementSyntaxes.Length; i++)
            {
                var statementSyntax = statementSyntaxes[i];

                if (statementSyntax is DeferStatementSyntax deferSyntax)
                {
                    var defer = BindDeferStatementInBlock(deferSyntax);
                    statements.AddRange(defer.PrefixStatements);
                    if (defer.Cleanup == null)
                    {
                        statements.Add(defer.ErrorStatement);
                        InvalidateNarrowingsForAssignedVariables(statementSyntax);
                        continue;
                    }

                    InvalidateNarrowingsForAssignedVariables(statementSyntax);
                    var innerStatements = ImmutableArray.CreateBuilder<BoundStatement>();
                    BindBlockStatements(statementSyntaxes, i + 1, innerStatements);
                    statements.Add(BuildCleanupTryStatement(innerStatements.ToImmutable(), defer.Cleanup));
                    return;
                }

                if (statementSyntax is UsingStatementSyntax usingSyntax)
                {
                    var usingLowering = BindUsingStatementInBlock(usingSyntax);
                    if (usingLowering.Declaration != null)
                    {
                        statements.Add(usingLowering.Declaration);
                    }

                    if (usingLowering.Cleanup == null)
                    {
                        statements.Add(usingLowering.ErrorStatement);
                        InvalidateNarrowingsForAssignedVariables(statementSyntax);
                        continue;
                    }

                    InvalidateNarrowingsForAssignedVariables(statementSyntax);
                    var innerStatements = ImmutableArray.CreateBuilder<BoundStatement>();
                    BindBlockStatements(statementSyntaxes, i + 1, innerStatements);
                    statements.Add(BuildCleanupTryStatement(innerStatements.ToImmutable(), usingLowering.Cleanup));
                    return;
                }

                var statement = BindStatement(statementSyntax);
                statements.Add(statement);

                // Issue #208: after binding a call statement, apply any
                // [MemberNotNull] post-condition narrowings to the persistent frame.
                ApplyMemberNotNullNarrowings(statement, memberNotNullFrame);

                // Phase 3.C.4: mutation invalidates the narrowing. After binding
                // a statement that writes to a narrowed variable, drop its
                // narrowing from the current frame so subsequent reads in this
                // block see the variable at its declared (nullable) type again.
                InvalidateNarrowingsForAssignedVariables(statementSyntax);
            }
        }
        finally
        {
            narrowedVariables.RemoveAt(narrowedVariables.Count - 1);
        }
    }

    /// <summary>
    /// If <paramref name="statement"/> is a call expression statement whose
    /// called function carries <c>[MemberNotNull("_f", …)]</c>, narrows each
    /// named field (via its <see cref="ImplicitFieldVariableSymbol"/>) to its
    /// underlying non-nullable type in <paramref name="frame"/>.
    /// </summary>
    private void ApplyMemberNotNullNarrowings(BoundStatement statement, Dictionary<VariableSymbol, TypeSymbol> frame)
    {
        BoundExpression callExpr = null;
        if (statement is BoundExpressionStatement exprStmt)
        {
            callExpr = exprStmt.Expression;
        }

        if (callExpr == null)
        {
            return;
        }

        ImmutableArray<string> memberNames;
        switch (callExpr)
        {
            case BoundCallExpression userCall:
                if (!KnownAttributes.TryGetMemberNotNullMembers(userCall.Function.Attributes, out memberNames))
                {
                    return;
                }

                break;

            case BoundImportedCallExpression importedCall:
                if (!ClrNullability.TryGetMemberNotNullMembers(importedCall.Function.Method, out memberNames))
                {
                    return;
                }

                break;

            case BoundImportedInstanceCallExpression instanceCall:
                if (!ClrNullability.TryGetMemberNotNullMembers(instanceCall.Method, out memberNames))
                {
                    return;
                }

                break;

            case BoundUserInstanceCallExpression userInstanceCall:
                if (!KnownAttributes.TryGetMemberNotNullMembers(userInstanceCall.Method.Attributes, out memberNames))
                {
                    return;
                }

                break;

            default:
                return;
        }

        foreach (var name in memberNames)
        {
            NarrowFieldIfNullable(name, frame);
        }
    }

    /// <summary>
    /// Looks up <paramref name="fieldName"/> in the current scope. If it
    /// resolves to an <see cref="ImplicitFieldVariableSymbol"/> whose declared
    /// type is nullable, adds a narrowing entry to <paramref name="frame"/>
    /// that maps the symbol to its underlying non-nullable type.
    /// </summary>
    private void NarrowFieldIfNullable(string fieldName, Dictionary<VariableSymbol, TypeSymbol> frame)
    {
        if (scope.TryLookupSymbol(fieldName) is ImplicitFieldVariableSymbol fieldVar
            && fieldVar.Type is NullableTypeSymbol nullable)
        {
            frame[fieldVar] = nullable.UnderlyingType;
        }
    }

    private BoundTryStatement BuildCleanupTryStatement(ImmutableArray<BoundStatement> protectedStatements, BoundExpression cleanup)
    {
        var tryBlock = new BoundBlockStatement(null, protectedStatements);
        var finallyBlock = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, cleanup)));
        return new BoundTryStatement(null, tryBlock, ImmutableArray<BoundCatchClause>.Empty, finallyBlock);
    }

    private void InvalidateNarrowingsForAssignedVariables(SyntaxNode statementSyntax)
    {
        if (narrowedVariables.Count == 0)
        {
            return;
        }

        var assignedNames = new HashSet<string>();
        CollectAssignedNames(statementSyntax, assignedNames);
        if (assignedNames.Count == 0)
        {
            return;
        }

        // Resolve each name through the current scope and drop any matching
        // narrowing from ALL active frames. We don't need to be conservative
        // about scope shadowing: the narrowed variable lives in an outer scope,
        // so an inner shadowing declaration with the same name will resolve to a
        // different symbol, and the narrowing will simply not be triggered.
        // Issue #208: iterate ALL frames (not just the top) because the
        // memberNotNullFrame sits above the if-condition frames; dropping from
        // only the top would miss narrowings added by if-condition analysis.
        foreach (var name in assignedNames)
        {
            if (scope.TryLookupSymbol(name) is VariableSymbol v)
            {
                for (var i = narrowedVariables.Count - 1; i >= 0; i--)
                {
                    narrowedVariables[i].Remove(v);
                }
            }
        }
    }

    private static void CollectAssignedNames(SyntaxNode node, HashSet<string> assigned)
    {
        switch (node)
        {
            case AssignmentExpressionSyntax a:
                assigned.Add(a.IdentifierToken.Text);
                break;
            case MultiAssignmentStatementSyntax m:
                foreach (var t in m.Targets)
                {
                    if (t is NameExpressionSyntax ne)
                    {
                        assigned.Add(ne.IdentifierToken.Text);
                    }
                }

                break;
        }

        foreach (var child in node.GetChildren())
        {
            CollectAssignedNames(child, assigned);
        }
    }

    private BoundStatement BindVariableDeclaration(VariableDeclarationSyntax syntax)
    {
        var isReadOnly = syntax.Keyword?.Kind == SyntaxKind.ConstKeyword
            || syntax.Keyword?.Kind == SyntaxKind.LetKeyword;
        var type = BindTypeClause(syntax.TypeClause);

        BoundExpression convertedInitializer;
        TypeSymbol variableType;
        if (syntax.Initializer == null)
        {
            // Bare `var x T` declaration: the variable is initialized to the
            // type's default value (Go-style zero value). The parser only
            // produces a null initializer when a type clause is present.
            variableType = type ?? TypeSymbol.Error;
            convertedInitializer = new BoundDefaultExpression(syntax, variableType);
        }
        else
        {
            var initializer = BindExpression(syntax.Initializer);
            variableType = type ?? initializer.Type;
            convertedInitializer = BindConversion(syntax.Initializer.Location, initializer, variableType);
        }

        var accessibility = ResolveAccessibility(syntax.AccessibilityModifier);
        var variable = BindVariableDeclaration(syntax.Identifier, isReadOnly, variableType, accessibility);

        // Issue #187 / ADR-0047 §3: bind any `@Foo` annotations and attach
        // them to the variable symbol so #175 use-site diagnostics
        // (e.g. `@Obsolete`) fire when the variable is read or written.
        // Globals (`GlobalVariableSymbol`) will eventually round-trip these
        // to CLR `CustomAttribute` rows on their backing static field; for
        // locals the attributes carry compiler-recognised semantics only.
        if (variable != null && !syntax.Annotations.IsDefaultOrEmpty)
        {
            var positionDescription = variable is GlobalVariableSymbol
                ? "a top-level variable declaration"
                : "a local variable declaration";
            var boundAttrs = BindAttributes(
                syntax.Annotations,
                AttributeTargetKind.Field,
                VariableDeclarationAllowedTargets,
                positionDescription,
                System.AttributeTargets.Field);
            variable.SetAttributes(boundAttrs);
        }

        // Issue #216: a `const` declaration whose converted initializer is a
        // literal expression carries a compile-time ConstantValue. The emitter
        // uses this to skip IL slot allocation and emit a LocalConstant PDB row.
        object constValue = null;
        if (syntax.Keyword?.Kind == SyntaxKind.ConstKeyword
            && convertedInitializer is BoundLiteralExpression litExpr)
        {
            constValue = litExpr.Value;
        }

        return new BoundVariableDeclaration(syntax, variable, convertedInitializer, constValue);
    }

    private BoundStatement BindTupleDeconstructionStatement(TupleDeconstructionStatementSyntax syntax)
    {
        // Phase 4.5: `let (a, b, ...) = expr`. Phase 7.3 extends the RHS from
        // tuple-only to data structs, preserving single-eval via a synthetic local.
        var initializer = BindExpression(syntax.Initializer);
        if (initializer.Type == TypeSymbol.Error)
        {
            return new BoundExpressionStatement(syntax, initializer);
        }

        if (initializer.Type is TupleTypeSymbol tupleType)
        {
            if (syntax.Identifiers.Count != tupleType.Arity)
            {
                Diagnostics.ReportDeconstructionFieldCountMismatch(syntax.CloseParenToken.Location, tupleType.Arity, syntax.Identifiers.Count);
                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
            }

            var tempName = $"<tuple{System.Threading.Interlocked.Increment(ref syntheticLocalCounter)}>";
            var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, tupleType);
            scope.TryDeclareVariable(tempVar);

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            statements.Add(new BoundVariableDeclaration(syntax, tempVar, initializer));

            for (var i = 0; i < syntax.Identifiers.Count; i++)
            {
                var idTok = syntax.Identifiers[i];
                var elemType = tupleType.ElementTypes[i];
                var elemVar = BindVariableDeclaration(idTok, isReadOnly: true, elemType);
                var access = new BoundTupleElementAccessExpression(null, new BoundVariableExpression(null, tempVar), tupleType, i);
                statements.Add(new BoundVariableDeclaration(syntax, elemVar, access));
            }

            return new BoundBlockStatement(syntax, statements.ToImmutable());
        }

        if (initializer.Type is StructSymbol structType && (structType.IsData || structType.IsInline))
        {
            var fields = structType.Fields;
            if (syntax.Identifiers.Count != fields.Length)
            {
                Diagnostics.ReportDeconstructionFieldCountMismatch(syntax.CloseParenToken.Location, fields.Length, syntax.Identifiers.Count);
                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
            }

            var tempName = $"<data{System.Threading.Interlocked.Increment(ref syntheticLocalCounter)}>";
            var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, structType);
            scope.TryDeclareVariable(tempVar);

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            statements.Add(new BoundVariableDeclaration(syntax, tempVar, initializer));
            for (var i = 0; i < syntax.Identifiers.Count; i++)
            {
                var idTok = syntax.Identifiers[i];
                var field = fields[i];
                var elemVar = BindVariableDeclaration(idTok, isReadOnly: true, field.Type);
                var access = new BoundFieldAccessExpression(null, new BoundVariableExpression(null, tempVar), structType, field);
                statements.Add(new BoundVariableDeclaration(syntax, elemVar, access));
            }

            return new BoundBlockStatement(syntax, statements.ToImmutable());
        }

        Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(syntax.OpenParenToken.Location, initializer.Type);
        return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
    }

    private BoundStatement BindNamedDeconstructionStatement(NamedDeconstructionStatementSyntax syntax)
    {
        var initializer = BindExpression(syntax.Initializer);
        if (initializer.Type == TypeSymbol.Error)
        {
            return new BoundExpressionStatement(syntax, initializer);
        }

        if (!(initializer.Type is StructSymbol structType) || (!structType.IsData && !structType.IsInline))
        {
            Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(syntax.OpenBraceToken.Location, initializer.Type);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var tempName = $"<data{System.Threading.Interlocked.Increment(ref syntheticLocalCounter)}>";
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, structType);
        scope.TryDeclareVariable(tempVar);

        var seen = new HashSet<string>();
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(syntax, tempVar, initializer));
        foreach (var fieldSyntax in syntax.Fields)
        {
            var fieldName = fieldSyntax.FieldIdentifier.Text;
            if (!seen.Add(fieldName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            if (!structType.TryGetFieldIncludingInherited(fieldName, out var field, out var declaringType))
            {
                Diagnostics.ReportUnableToFindMember(fieldSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            var variable = BindVariableDeclaration(fieldSyntax.LocalIdentifier, isReadOnly: true, field.Type);
            var access = new BoundFieldAccessExpression(null, new BoundVariableExpression(null, tempVar), declaringType, field);
            statements.Add(new BoundVariableDeclaration(syntax, variable, access));
        }

        return new BoundBlockStatement(syntax, statements.ToImmutable());
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
                    ret = WrapAsTask(ret);
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
        if (syntax.HasTypeArguments &&
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
                clrArgs[i] = scope.References.MapClrTypeToReferences(ta.ClrType);
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

        var element = LookupType(syntax.Identifier.Text);
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
            else
            {
                Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.Identifier.Text);
                return null;
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

    private BoundStatement BindIfStatement(IfStatementSyntax syntax)
    {
        if (syntax.Initializer == null)
        {
            var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);

            // Phase 3.C.4/6.6: recognise one top-level nullable guard. Boolean
            // conjunction/disjunction flow (for example `s != nil && IsValid(s)`)
            // is intentionally deferred.
            var (thenNarrow, elseNarrow) = TryClassifyNilGuard(condition);
            if (thenNarrow == null && elseNarrow == null)
            {
                (thenNarrow, elseNarrow) = TryClassifyBoolCallNarrowing(condition);
            }

            var thenStatement = BindStatementWithNarrowing(syntax.ThenStatement, thenNarrow);
            var elseStatement = syntax.ElseClause == null ? null : BindStatementWithNarrowing(syntax.ElseClause.ElseStatement, elseNarrow);
            return new BoundIfStatement(syntax, condition, thenStatement, elseStatement);
        }

        // `if init; cond { then } else { else }` lowers to a block that
        // scopes the initializer to both arms:
        //   {
        //     <init>
        //     if cond { then } else { else }
        //   }
        scope = new BoundScope(scope);

        var initStatement = BindStatement(syntax.Initializer);
        var initCondition = BindExpression(syntax.Condition, TypeSymbol.Bool);
        var initThen = BindStatement(syntax.ThenStatement);
        var initElse = syntax.ElseClause == null ? null : BindStatement(syntax.ElseClause.ElseStatement);

        scope = scope.Parent;

        var inner = new BoundIfStatement(syntax, initCondition, initThen, initElse);
        return new BoundBlockStatement(syntax, ImmutableArray.Create<BoundStatement>(initStatement, inner));
    }

    private (Dictionary<VariableSymbol, TypeSymbol> NonNil, Dictionary<VariableSymbol, TypeSymbol> Nil) TryClassifyNilGuard(BoundExpression condition)
    {
        // Phase 3.C.4: recognise the canonical narrowing patterns. We support
        // only single-variable guards here; conjunctions, disjunctions and
        // pattern-based narrowing are deferred.
        if (condition is not BoundBinaryExpression be)
        {
            return (null, null);
        }

        VariableSymbol target = null;
        if (be.Left is BoundVariableExpression lv && IsNilLiteral(be.Right))
        {
            target = lv.Variable;
        }
        else if (be.Right is BoundVariableExpression rv && IsNilLiteral(be.Left))
        {
            target = rv.Variable;
        }

        if (target == null || target.Type is not NullableTypeSymbol nullable)
        {
            return (null, null);
        }

        var underlying = nullable.UnderlyingType;
        Dictionary<VariableSymbol, TypeSymbol> nonNilFrame = null;
        Dictionary<VariableSymbol, TypeSymbol> nilFrame = null;
        if (be.Op.Kind == BoundBinaryOperatorKind.NotEquals)
        {
            nonNilFrame = new Dictionary<VariableSymbol, TypeSymbol> { [target] = underlying };
        }
        else if (be.Op.Kind == BoundBinaryOperatorKind.Equals)
        {
            nilFrame = new Dictionary<VariableSymbol, TypeSymbol> { [target] = underlying };
        }

        return (nonNilFrame, nilFrame);
    }

    private (Dictionary<VariableSymbol, TypeSymbol> Then, Dictionary<VariableSymbol, TypeSymbol> Else) TryClassifyBoolCallNarrowing(BoundExpression condition)
    {
        var negate = false;
        var inner = condition;
        if (inner is BoundUnaryExpression unary && unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation)
        {
            negate = true;
            inner = unary.Operand;
        }

        if (inner is BoundImportedCallExpression importedCall && importedCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = ClassifyImportedBoolCallNarrowing(importedCall, negate);
            MergeClrMemberNotNullWhenNarrowings(importedCall.Function.Method, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        if (inner is BoundImportedInstanceCallExpression importedInstanceCall && importedInstanceCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = ClassifyImportedMethodBoolCallNarrowing(importedInstanceCall.Method.GetParameters(), importedInstanceCall.Arguments, negate);
            MergeClrMemberNotNullWhenNarrowings(importedInstanceCall.Method, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        if (inner is BoundCallExpression userCall && userCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = ClassifyUserBoolCallNarrowing(userCall, negate);
            MergeUserMemberNotNullWhenNarrowings(userCall.Function.Attributes, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        if (inner is BoundUserInstanceCallExpression userInstanceCall && userInstanceCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = (default(Dictionary<VariableSymbol, TypeSymbol>), default(Dictionary<VariableSymbol, TypeSymbol>));
            MergeUserMemberNotNullWhenNarrowings(userInstanceCall.Method.Attributes, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        return (null, null);
    }

    // Issue #208: merge [MemberNotNullWhen] field narrowings from a CLR-imported method.
    private void MergeClrMemberNotNullWhenNarrowings(
        System.Reflection.MethodInfo method,
        bool negate,
        ref Dictionary<VariableSymbol, TypeSymbol> thenFrame,
        ref Dictionary<VariableSymbol, TypeSymbol> elseFrame)
    {
        if (!ClrNullability.TryGetMemberNotNullWhenData(method, out var returnValue, out var members))
        {
            return;
        }

        var narrowThen = returnValue != negate;
        var frame = narrowThen ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>()) : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
        foreach (var name in members)
        {
            NarrowFieldIfNullable(name, frame);
        }
    }

    // Issue #208: merge [MemberNotNullWhen] field narrowings from a user-declared method.
    private void MergeUserMemberNotNullWhenNarrowings(
        ImmutableArray<BoundAttribute> attributes,
        bool negate,
        ref Dictionary<VariableSymbol, TypeSymbol> thenFrame,
        ref Dictionary<VariableSymbol, TypeSymbol> elseFrame)
    {
        if (attributes.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var attr in attributes)
        {
            if (!KnownAttributes.TryGetMemberNotNullWhenData(attr, out var returnValue, out var members))
            {
                continue;
            }

            var narrowThen = returnValue != negate;
            var frame = narrowThen ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>()) : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
            foreach (var name in members)
            {
                NarrowFieldIfNullable(name, frame);
            }
        }
    }

    private static (Dictionary<VariableSymbol, TypeSymbol> Then, Dictionary<VariableSymbol, TypeSymbol> Else) ClassifyImportedBoolCallNarrowing(BoundImportedCallExpression call, bool negate)
        => ClassifyImportedMethodBoolCallNarrowing(call.Function.Method.GetParameters(), call.Arguments, negate);

    private static (Dictionary<VariableSymbol, TypeSymbol> Then, Dictionary<VariableSymbol, TypeSymbol> Else) ClassifyImportedMethodBoolCallNarrowing(
        ParameterInfo[] parameters,
        ImmutableArray<BoundExpression> arguments,
        bool negate)
    {
        Dictionary<VariableSymbol, TypeSymbol> thenFrame = null;
        Dictionary<VariableSymbol, TypeSymbol> elseFrame = null;
        var count = Math.Min(parameters.Length, arguments.Length);
        for (var i = 0; i < count; i++)
        {
            var parameter = parameters[i];

            // [MaybeNullWhen(rv)] on a non-nullable argument widens the caller's
            // variable to its nullable counterpart on the arm where the call returns
            // rv. The argument may be a plain variable or an address-of expression
            // (&var) when the CLR parameter is declared `out T`.
            if (ClrNullability.TryGetMaybeNullWhen(parameter, out var maybeNullWhenReturnValue))
            {
                var rawArg = arguments[i];
                var widenArg = rawArg is BoundAddressOfExpression addrOf ? addrOf.Operand : rawArg;
                if (widenArg is BoundVariableExpression widenVarExpr
                    && widenVarExpr.Variable.Type is not NullableTypeSymbol
                    && widenVarExpr.Variable.Type != TypeSymbol.Null)
                {
                    var widenThen = maybeNullWhenReturnValue != negate;
                    var widenFrame = widenThen
                        ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>())
                        : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
                    widenFrame[widenVarExpr.Variable] = NullableTypeSymbol.Get(widenVarExpr.Variable.Type);
                }

                continue;
            }

            if (!ClrNullability.TryGetNotNullWhen(parameter, out var returnValue)
                || arguments[i] is not BoundVariableExpression variableExpression
                || variableExpression.Variable.Type is not NullableTypeSymbol nullable)
            {
                continue;
            }

            var narrowThen = returnValue != negate;
            var frame = narrowThen ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>()) : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
            frame[variableExpression.Variable] = nullable.UnderlyingType;
        }

        return (thenFrame, elseFrame);
    }

    private static (Dictionary<VariableSymbol, TypeSymbol> Then, Dictionary<VariableSymbol, TypeSymbol> Else) ClassifyUserBoolCallNarrowing(BoundCallExpression call, bool negate)
    {
        // Issue #178 / ADR-0047 §6: a user-declared function may carry the
        // same [NotNullWhen] / [MaybeNullWhen] postconditions C# uses.
        // Recognition is type-identity based via KnownAttributes so renaming
        // or shadowing the source name cannot bypass the narrowing rule.
        var parameters = call.Function.Parameters;
        Dictionary<VariableSymbol, TypeSymbol> thenFrame = null;
        Dictionary<VariableSymbol, TypeSymbol> elseFrame = null;
        var count = Math.Min(parameters.Length, call.Arguments.Length);
        for (var i = 0; i < count; i++)
        {
            var parameter = parameters[i];
            var attributes = parameter.Attributes;
            if (attributes.IsDefaultOrEmpty)
            {
                continue;
            }

            var notNullWhenReturnValue = (bool?)null;
            var maybeNullWhenReturnValue = (bool?)null;
            foreach (var attribute in attributes)
            {
                if (KnownAttributes.TryGetNotNullWhenReturnValue(attribute, out var rv))
                {
                    notNullWhenReturnValue = rv;
                }
                else if (KnownAttributes.TryGetMaybeNullWhenReturnValue(attribute, out var mrv))
                {
                    maybeNullWhenReturnValue = mrv;
                }
            }

            var argExpr = call.Arguments[i];

            // [NotNullWhen(rv)]: narrow a nullable argument to its underlying
            // non-nullable type on the arm where the call returns rv.
            if (notNullWhenReturnValue is bool returnValue
                && argExpr is BoundVariableExpression narrowVarExpr
                && narrowVarExpr.Variable.Type is NullableTypeSymbol nullable)
            {
                var narrowThen = returnValue != negate;
                var frame = narrowThen
                    ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>())
                    : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
                frame[narrowVarExpr.Variable] = nullable.UnderlyingType;
            }

            // [MaybeNullWhen(rv)]: widen a non-nullable argument to its nullable
            // counterpart on the arm where the call returns rv.
            if (maybeNullWhenReturnValue is bool widenReturnValue
                && argExpr is BoundVariableExpression widenVarExpr
                && widenVarExpr.Variable.Type is not NullableTypeSymbol
                && widenVarExpr.Variable.Type != TypeSymbol.Null)
            {
                var widenThen = widenReturnValue != negate;
                var widenFrame = widenThen
                    ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>())
                    : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
                widenFrame[widenVarExpr.Variable] = NullableTypeSymbol.Get(widenVarExpr.Variable.Type);
            }
        }

        return (thenFrame, elseFrame);
    }

    private static bool IsNilLiteral(BoundExpression expr)
    {
        while (expr is BoundConversionExpression conversion)
        {
            expr = conversion.Expression;
        }

        return expr is BoundLiteralExpression lit && lit.Type == TypeSymbol.Null;
    }

    private static Dictionary<VariableSymbol, TypeSymbol> TryClassifyPatternNarrowing(BoundExpression discriminant, BoundPattern pattern)
    {
        if (discriminant is not BoundVariableExpression variableExpression || pattern == null)
        {
            return null;
        }

        var variable = variableExpression.Variable;
        TypeSymbol narrowedType = null;
        switch (pattern)
        {
            case BoundTypePattern typePattern:
                narrowedType = typePattern.TargetType;
                break;
            case BoundConstantPattern constantPattern when variable.Type is NullableTypeSymbol nullable && !IsNilLiteral(constantPattern.Value):
                narrowedType = nullable.UnderlyingType;
                break;
            case BoundDiscardPattern:
                break;
            case BoundRelationalPattern:
            case BoundPropertyPattern:
            case BoundListPattern:
                // These patterns can imply non-nullness in some cases, but this
                // phase keeps narrowing to simple type and non-nil constant arms.
                break;
        }

        return narrowedType == null ? null : new Dictionary<VariableSymbol, TypeSymbol> { [variable] = narrowedType };
    }

    private BoundStatement BindStatementWithNarrowing(StatementSyntax syntax, Dictionary<VariableSymbol, TypeSymbol> frame)
    {
        if (frame == null)
        {
            return BindStatement(syntax);
        }

        narrowedVariables.Add(frame);
        try
        {
            return BindStatement(syntax);
        }
        finally
        {
            narrowedVariables.RemoveAt(narrowedVariables.Count - 1);
        }
    }

    private BoundExpression BindExpressionWithNarrowing(ExpressionSyntax syntax, Dictionary<VariableSymbol, TypeSymbol> frame)
    {
        if (frame == null)
        {
            return BindExpression(syntax);
        }

        narrowedVariables.Add(frame);
        try
        {
            return BindExpression(syntax);
        }
        finally
        {
            narrowedVariables.RemoveAt(narrowedVariables.Count - 1);
        }
    }

    private BoundStatement BindMultiAssignmentStatement(MultiAssignmentStatementSyntax syntax)
    {
        var targets = syntax.Targets.ToImmutableArray();
        var values = syntax.Values.ToImmutableArray();

        if (targets.Length != values.Length)
        {
            Diagnostics.ReportMultiAssignmentMismatch(syntax.Location, targets.Length, values.Length);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var isShortDecl = syntax.OperatorToken.Kind == SyntaxKind.ColonEqualsToken;

        if (isShortDecl)
        {
            for (var i = 0; i < targets.Length; i++)
            {
                var nameExpr = (NameExpressionSyntax)targets[i];
                var initializer = BindExpression(values[i]);
                var variable = BindVariableDeclaration(nameExpr.IdentifierToken, isReadOnly: false, type: initializer.Type);
                statements.Add(new BoundVariableDeclaration(syntax, variable, initializer));
            }

            return new BoundBlockStatement(syntax, statements.ToImmutable());
        }

        // Plain assignment: evaluate every RHS into a fresh temp, then assign each temp to its target.
        // This is the semantics Go specifies for `a, b = b, a` and friends.
        var temps = ImmutableArray.CreateBuilder<VariableSymbol>(targets.Length);
        var basePos = syntax.OperatorToken.Position;
        for (var i = 0; i < values.Length; i++)
        {
            var initializer = BindExpression(values[i]);
            var tempName = $"<>m_{basePos}_{i}";
            var temp = function == null
                ? (VariableSymbol)new GlobalVariableSymbol(tempName, isReadOnly: true, initializer.Type)
                : new LocalVariableSymbol(tempName, isReadOnly: true, initializer.Type);
            scope.TryDeclareVariable(temp);
            temps.Add(temp);
            statements.Add(new BoundVariableDeclaration(syntax, temp, initializer));
        }

        for (var i = 0; i < targets.Length; i++)
        {
            var nameExpr = (NameExpressionSyntax)targets[i];
            var name = nameExpr.IdentifierToken.Text;
            var variable = BindVariableReference(name, nameExpr.IdentifierToken.Location);
            if (variable == null)
            {
                continue;
            }

            if (variable.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
            }

            var tempRef = new BoundVariableExpression(null, temps[i]);
            var converted = BindConversion(values[i].Location, tempRef, variable.Type);
            statements.Add(new BoundExpressionStatement(syntax, new BoundAssignmentExpression(null, variable, converted)));
        }

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private BoundStatement BindSwitchStatement(SwitchStatementSyntax syntax)
    {
        var discriminant = BindExpression(syntax.Expression);
        var switchType = discriminant.Type;
        if (switchType == TypeSymbol.Error)
        {
            return BindErrorStatement();
        }

        var arms = ImmutableArray.CreateBuilder<BoundPatternSwitchArm>(syntax.Cases.Length);
        var hasDefault = false;

        foreach (var caseSyntax in syntax.Cases)
        {
            if (caseSyntax.IsDefault)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(caseSyntax.Keyword.Location);
                }

                hasDefault = true;
                arms.Add(new BoundPatternSwitchArm(null, pattern: null, BindBlockStatement(caseSyntax.Body)));
                continue;
            }

            scope = new BoundScope(scope);
            var pattern = BindPattern(caseSyntax.Value, switchType);
            if (pattern is BoundDiscardPattern)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(caseSyntax.Value.Location);
                }

                hasDefault = true;
            }

            var frame = TryClassifyPatternNarrowing(discriminant, pattern);
            var body = BindStatementWithNarrowing(caseSyntax.Body, frame);
            scope = scope.Parent;
            arms.Add(new BoundPatternSwitchArm(null, pattern, body));
        }

        var boundArms = arms.ToImmutable();
        ExhaustivenessAnalyzer.AnalyzeSwitchStatement(
            syntax.SwitchKeyword.Location,
            switchType,
            boundArms,
            scope.GetDeclaredStructs(),
            Diagnostics);

        return new BoundPatternSwitchStatement(null, discriminant, boundArms);
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
            pattern = BindPattern(armSyntax.Value, switchType);
            if (pattern is BoundDiscardPattern)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(armSyntax.Value.Location);
                }

                hasDefault = true;
            }

            var frame = TryClassifyPatternNarrowing(discriminant, pattern);
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

    private BoundPattern BindPattern(PatternSyntax syntax, TypeSymbol discriminantType)
    {
        switch (syntax.Kind)
        {
            case SyntaxKind.ConstantPattern:
                return BindConstantPattern((ConstantPatternSyntax)syntax, discriminantType);
            case SyntaxKind.DiscardPattern:
                return new BoundDiscardPattern(syntax, discriminantType);
            case SyntaxKind.TypePattern:
                return BindTypePattern((TypePatternSyntax)syntax, discriminantType);
            case SyntaxKind.PropertyPattern:
                return BindPropertyPattern((PropertyPatternSyntax)syntax, discriminantType);
            case SyntaxKind.RelationalPattern:
                return BindRelationalPattern((RelationalPatternSyntax)syntax, discriminantType);
            case SyntaxKind.ListPattern:
                return BindListPattern((ListPatternSyntax)syntax, discriminantType);
            default:
                throw new Exception($"Unexpected pattern syntax {syntax.Kind}");
        }
    }

    private BoundPattern BindConstantPattern(ConstantPatternSyntax syntax, TypeSymbol discriminantType)
    {
        var expression = BindExpression(syntax.Expression);
        var conversion = Conversion.Classify(expression.Type, discriminantType);
        if (!conversion.Exists || conversion.IsExplicit)
        {
            if (expression.Type != TypeSymbol.Error && discriminantType != TypeSymbol.Error)
            {
                Diagnostics.ReportSwitchCaseTypeMismatch(syntax.Expression.Location, expression.Type, discriminantType);
            }

            return new BoundConstantPattern(syntax, discriminantType, new BoundErrorExpression(syntax));
        }

        var value = conversion.IsIdentity ? expression : new BoundConversionExpression(syntax, discriminantType, expression);
        var op = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, discriminantType, discriminantType);
        if (op == null && discriminantType is NullableTypeSymbol nullable)
        {
            var comparisonType = IsNilLiteral(expression) ? TypeSymbol.Null : nullable.UnderlyingType;
            op = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, discriminantType, comparisonType)
                ?? BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, nullable.UnderlyingType, nullable.UnderlyingType);
        }

        if (op == null && expression.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportSwitchCaseTypeMismatch(syntax.Expression.Location, expression.Type, discriminantType);
        }

        return new BoundConstantPattern(syntax, discriminantType, value);
    }

    private BoundPattern BindTypePattern(TypePatternSyntax syntax, TypeSymbol discriminantType)
    {
        var targetType = BindTypeClause(syntax.Type) ?? TypeSymbol.Error;
        var variable = new LocalVariableSymbol(syntax.Identifier.Text, isReadOnly: true, targetType, declaringSyntax: syntax.Identifier);
        if (!scope.TryDeclareVariable(variable))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, syntax.Identifier.Text);
        }

        return new BoundTypePattern(syntax, discriminantType, targetType, variable);
    }

    private BoundPattern BindPropertyPattern(PropertyPatternSyntax syntax, TypeSymbol discriminantType)
    {
        var fields = ImmutableArray.CreateBuilder<BoundPropertyPatternField>();
        if (discriminantType is not StructSymbol structType)
        {
            Diagnostics.ReportPropertyPatternRequiresStructOrClass(syntax.OpenBraceToken.Location, discriminantType);
            return new BoundPropertyPattern(syntax, discriminantType, fields.ToImmutable());
        }

        foreach (var fieldSyntax in syntax.Fields)
        {
            if (!structType.TryGetFieldIncludingInherited(fieldSyntax.Identifier.Text, out var field, out _))
            {
                Diagnostics.ReportUndefinedFieldOnType(fieldSyntax.Identifier.Location, fieldSyntax.Identifier.Text, discriminantType);
                fields.Add(new BoundPropertyPatternField(syntax, new FieldSymbol(fieldSyntax.Identifier.Text, TypeSymbol.Error, Accessibility.Public), BindPattern(fieldSyntax.Pattern, TypeSymbol.Error)));
                continue;
            }

            fields.Add(new BoundPropertyPatternField(syntax, field, BindPattern(fieldSyntax.Pattern, field.Type)));
        }

        return new BoundPropertyPattern(syntax, discriminantType, fields.ToImmutable());
    }

    private BoundPattern BindRelationalPattern(RelationalPatternSyntax syntax, TypeSymbol discriminantType)
    {
        var value = BindConversion(syntax.Expression, discriminantType, allowExplicit: false);
        var op = BoundBinaryOperator.Bind(syntax.OperatorToken.Kind, discriminantType, discriminantType);
        if (op == null)
        {
            Diagnostics.ReportRelationalPatternOperatorUndefined(syntax.OperatorToken.Location, syntax.OperatorToken.Kind, discriminantType);
            op = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32);
        }

        return new BoundRelationalPattern(syntax, discriminantType, op, value);
    }

    private BoundPattern BindListPattern(ListPatternSyntax syntax, TypeSymbol discriminantType)
    {
        TypeSymbol elementType = TypeSymbol.Error;
        if (discriminantType is ArrayTypeSymbol arrayType)
        {
            elementType = arrayType.ElementType;
        }
        else if (discriminantType is SliceTypeSymbol sliceType)
        {
            elementType = sliceType.ElementType;
        }
        else
        {
            Diagnostics.ReportListPatternRequiresArrayOrSlice(syntax.OpenSquareBracketToken.Location, discriminantType);
        }

        var elements = ImmutableArray.CreateBuilder<BoundPattern>();
        foreach (var elementSyntax in syntax.Elements)
        {
            elements.Add(BindPattern(elementSyntax, elementType));
        }

        return new BoundListPattern(syntax, discriminantType, elements.ToImmutable(), elementType);
    }

    private BoundStatement BindTryStatement(TryStatementSyntax syntax)
    {
        var tryBlock = BindBlockStatement(syntax.TryBlock);

        var exceptionType = ResolveExceptionType();
        if (exceptionType == null)
        {
            Diagnostics.ReportUndefinedType(syntax.TryKeyword.Location, "System.Exception");
            return BindErrorStatement();
        }

        var catches = ImmutableArray.CreateBuilder<BoundCatchClause>();
        foreach (var catchSyntax in syntax.CatchClauses)
        {
            var catchType = exceptionType;
            if (catchSyntax.TypeClause != null)
            {
                var declared = BindTypeClause(catchSyntax.TypeClause);
                if (declared != null)
                {
                    catchType = declared;
                }
            }

            scope = new BoundScope(scope);
            var variable = BindVariableDeclaration(catchSyntax.Identifier, isReadOnly: true, type: catchType);
            var body = BindBlockStatement(catchSyntax.Body);
            scope = scope.Parent;

            catches.Add(new BoundCatchClause(catchType, variable, body));
        }

        BoundStatement finallyBlock = null;
        if (syntax.FinallyClause != null)
        {
            finallyBlock = BindBlockStatement(syntax.FinallyClause.Body);
        }

        if (catches.Count == 0 && finallyBlock == null)
        {
            Diagnostics.ReportTryWithoutCatchOrFinally(syntax.TryKeyword.Location);
            return BindErrorStatement();
        }

        return new BoundTryStatement(syntax, tryBlock, catches.ToImmutable(), finallyBlock);
    }

    private BoundStatement BindThrowStatement(ThrowStatementSyntax syntax)
    {
        var expression = BindExpression(syntax.Expression);
        var exceptionType = ResolveExceptionType();
        if (exceptionType != null && expression.Type != TypeSymbol.Error)
        {
            var argClr = expression.Type?.ClrType;
            if (argClr == null || !ClrTypeUtilities.IsAssignableByName(exceptionType.ClrType, argClr))
            {
                Diagnostics.ReportCannotConvert(syntax.Expression.Location, expression.Type ?? TypeSymbol.Error, exceptionType);
                return BindErrorStatement();
            }
        }

        return new BoundThrowStatement(syntax, expression);
    }

    private BoundStatement BindUsingStatement(UsingStatementSyntax syntax)
    {
        var usingLowering = BindUsingStatementInBlock(syntax);
        if (usingLowering.Cleanup == null)
        {
            return usingLowering.ErrorStatement;
        }

        var tryStmt = BuildCleanupTryStatement(ImmutableArray<BoundStatement>.Empty, usingLowering.Cleanup);
        return new BoundBlockStatement(syntax, ImmutableArray.Create<BoundStatement>(usingLowering.Declaration, tryStmt));
    }

    private (BoundVariableDeclaration Declaration, BoundExpression Cleanup, BoundStatement ErrorStatement) BindUsingStatementInBlock(UsingStatementSyntax syntax)
    {
        var declaration = (BoundVariableDeclaration)BindVariableDeclaration(syntax.Declaration);
        var disposeCall = TryBuildDisposeCall(declaration.Variable, syntax.UsingKeyword.Location);
        if (disposeCall == null)
        {
            return (declaration, null, BindErrorStatement());
        }

        return (declaration, disposeCall, null);
    }

    private BoundStatement BindDeferStatement(DeferStatementSyntax syntax)
    {
        var defer = BindDeferStatementInBlock(syntax);
        if (defer.Cleanup == null)
        {
            return defer.ErrorStatement;
        }

        var tryStmt = BuildCleanupTryStatement(ImmutableArray<BoundStatement>.Empty, defer.Cleanup);
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.AddRange(defer.PrefixStatements);
        statements.Add(tryStmt);
        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private (ImmutableArray<BoundStatement> PrefixStatements, BoundExpression Cleanup, BoundStatement ErrorStatement) BindDeferStatementInBlock(DeferStatementSyntax syntax)
    {
        var expression = BindExpression(syntax.Expression, canBeVoid: true);
        if (expression is BoundErrorExpression)
        {
            return (ImmutableArray<BoundStatement>.Empty, null, new BoundExpressionStatement(null, expression));
        }

        if (!IsDeferableCall(expression))
        {
            Diagnostics.ReportDeferOperandIsNotACall(syntax.Expression.Location);
            return (ImmutableArray<BoundStatement>.Empty, null, new BoundExpressionStatement(null, new BoundErrorExpression(null)));
        }

        var prefix = ImmutableArray.CreateBuilder<BoundStatement>();
        var capturedCall = CaptureDeferArguments(expression, prefix);
        return (prefix.ToImmutable(), capturedCall, null);
    }

    private static bool IsDeferableCall(BoundExpression expression)
        => expression is BoundCallExpression or
            BoundIndirectCallExpression or
            BoundUserInstanceCallExpression or
            BoundImportedCallExpression or
            BoundImportedInstanceCallExpression;

    private BoundExpression CaptureDeferArguments(BoundExpression expression, ImmutableArray<BoundStatement>.Builder prefix)
    {
        switch (expression)
        {
            case BoundCallExpression call:
                return new BoundCallExpression(null, call.Function, CaptureArguments(call.Arguments, prefix), call.ReturnType);
            case BoundIndirectCallExpression call:
                return new BoundIndirectCallExpression(null, call.Target, call.FunctionType, CaptureArguments(call.Arguments, prefix));
            case BoundUserInstanceCallExpression call:
                return new BoundUserInstanceCallExpression(null, call.Receiver, call.Method, CaptureArguments(call.Arguments, prefix), call.Type);
            case BoundImportedCallExpression call:
                return new BoundImportedCallExpression(null, call.Function, CaptureArguments(call.Arguments, prefix));
            case BoundImportedInstanceCallExpression call:
                return new BoundImportedInstanceCallExpression(null, call.Receiver, call.Method, call.Type, CaptureArguments(call.Arguments, prefix));
            default:
                throw new InvalidOperationException($"Unexpected deferred expression: {expression.Kind}");
        }
    }

    private ImmutableArray<BoundExpression> CaptureArguments(ImmutableArray<BoundExpression> arguments, ImmutableArray<BoundStatement>.Builder prefix)
    {
        if (arguments.IsEmpty)
        {
            return arguments;
        }

        var capturedArguments = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        foreach (var argument in arguments)
        {
            var variable = new LocalVariableSymbol($"$defer$arg${deferArgumentCounter++}", isReadOnly: true, argument.Type ?? TypeSymbol.Error);
            scope.TryDeclareVariable(variable);
            prefix.Add(new BoundVariableDeclaration(null, variable, argument));
            capturedArguments.Add(new BoundVariableExpression(null, variable));
        }

        return capturedArguments.ToImmutable();
    }

    private BoundExpression TryBuildDisposeCall(VariableSymbol variable, TextLocation location)
    {
        var clrType = variable.Type?.ClrType;
        if (clrType == null)
        {
            Diagnostics.ReportTypeNotDisposable(location, variable.Type ?? TypeSymbol.Error);
            return null;
        }

        var disposeMethod = clrType.GetMethod("Dispose", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance, binder: null, types: System.Type.EmptyTypes, modifiers: null);
        if (disposeMethod == null)
        {
            Diagnostics.ReportTypeNotDisposable(location, variable.Type);
            return null;
        }

        var receiver = new BoundVariableExpression(null, variable);
        return new BoundImportedInstanceCallExpression(null, receiver, disposeMethod, TypeSymbol.Void, ImmutableArray<BoundExpression>.Empty);
    }

    private BoundStatement BindGoStatement(GoStatementSyntax syntax)
    {
        var expression = BindExpression(syntax.Expression);

        if (expression is BoundErrorExpression)
        {
            return new BoundExpressionStatement(syntax, expression);
        }

        if (expression is not BoundCallExpression and
            not BoundIndirectCallExpression and
            not BoundUserInstanceCallExpression and
            not BoundImportedCallExpression and
            not BoundImportedInstanceCallExpression)
        {
            Diagnostics.ReportGoOperandIsNotACall(syntax.Expression.Location);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        return new BoundGoStatement(syntax, expression);
    }

    private BoundStatement BindChannelSendStatement(ChannelSendStatementSyntax syntax)
    {
        // Phase 5.5 / ADR-0022: `ch <- v` send statement.
        var channel = BindExpression(syntax.Channel);
        if (channel is BoundErrorExpression)
        {
            return new BoundExpressionStatement(syntax, channel);
        }

        if (channel.Type is not ChannelTypeSymbol chan)
        {
            Diagnostics.ReportSendTargetIsNotChannel(syntax.Channel.Location, channel.Type);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var value = BindConversion(syntax.Value, chan.ElementType);
        return new BoundChannelSendStatement(syntax, channel, value);
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
            capacity = BindConversion(syntax.Capacity, TypeSymbol.Int32);
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

    private BoundStatement BindSelectStatement(SelectStatementSyntax syntax)
    {
        // Phase 5.6 / ADR-0022: select statement orchestrating channel ops.
        if (syntax.Cases.Length == 0)
        {
            Diagnostics.ReportSelectWithNoCases(syntax.SelectKeyword.Location);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var bound = ImmutableArray.CreateBuilder<BoundSelectCase>();
        var sawDefault = false;
        foreach (var caseSyntax in syntax.Cases)
        {
            if (caseSyntax.CaseKind == SelectCaseKind.Default)
            {
                if (sawDefault)
                {
                    Diagnostics.ReportSelectDuplicateDefault(caseSyntax.Keyword.Location);
                }

                sawDefault = true;
                var defaultBody = BindStatement(caseSyntax.Body);
                bound.Add(new BoundSelectCase(SelectCaseKind.Default, channel: null, value: null, variable: null, defaultBody));
                continue;
            }

            // All non-default arms reference a channel.
            var channelExpr = BindExpression(caseSyntax.Channel);
            ChannelTypeSymbol chan = channelExpr.Type as ChannelTypeSymbol;
            if (channelExpr is BoundErrorExpression || chan == null)
            {
                if (chan == null && channelExpr is not BoundErrorExpression)
                {
                    if (caseSyntax.CaseKind == SelectCaseKind.Send)
                    {
                        Diagnostics.ReportSendTargetIsNotChannel(caseSyntax.Channel.Location, channelExpr.Type);
                    }
                    else
                    {
                        Diagnostics.ReportReceiveOperandIsNotChannel(caseSyntax.Channel.Location, channelExpr.Type);
                    }
                }

                // Best-effort recover: bind the body anyway so further
                // diagnostics surface.
                var recoveredBody = BindStatement(caseSyntax.Body);
                bound.Add(new BoundSelectCase(caseSyntax.CaseKind, channelExpr, value: null, variable: null, recoveredBody));
                continue;
            }

            BoundExpression valueExpr = null;
            VariableSymbol variable = null;
            BoundStatement body;

            if (caseSyntax.CaseKind == SelectCaseKind.Send)
            {
                valueExpr = BindConversion(caseSyntax.Value, chan.ElementType);
                body = BindStatement(caseSyntax.Body);
            }
            else if (caseSyntax.CaseKind == SelectCaseKind.ReceiveBind)
            {
                // Introduce a scope so the bound variable is visible only inside
                // the case body — matches `for v := range` lexical hygiene.
                scope = new BoundScope(scope);
                variable = new LocalVariableSymbol(caseSyntax.Identifier.Text, isReadOnly: true, chan.ElementType, declaringSyntax: caseSyntax.Identifier);
                if (!scope.TryDeclareVariable(variable))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(caseSyntax.Identifier.Location, caseSyntax.Identifier.Text);
                }

                body = BindStatement(caseSyntax.Body);
                scope = scope.Parent;
            }
            else
            {
                // ReceiveDiscard
                body = BindStatement(caseSyntax.Body);
            }

            bound.Add(new BoundSelectCase(caseSyntax.CaseKind, channelExpr, valueExpr, variable, body));
        }

        return new BoundSelectStatement(syntax, bound.ToImmutable());
    }

    private BoundStatement BindScopeStatement(ScopeStatementSyntax syntax)
    {
        // Phase 5.7 / ADR-0022: structured concurrency. The body's `go`
        // statements register with the scope at evaluation time; the binder
        // itself just wraps the body. Open a fresh lexical scope so any
        // future implicit binding (e.g. `ctx`) can be introduced without
        // leaking into the enclosing function.
        scope = new BoundScope(scope);
        var body = BindStatement(syntax.Body);
        scope = scope.Parent;
        return new BoundScopeStatement(syntax, body);
    }

    private BoundStatement BindAwaitForRangeStatement(AwaitForRangeStatementSyntax syntax)
    {
        // Phase 5.8 / ADR-0023: `await for v := range stream { … }`.
        // The stream operand must be an `IAsyncEnumerable[T]` (a CLR type
        // that exposes a `GetAsyncEnumerator` method). The value variable
        // is typed as the stream's element `T`. The interpreter handles
        // the underlying `MoveNextAsync`/`Current`/`DisposeAsync` cycle
        // synchronously (matching Phase 5.1's `await` lowering). The
        // async-aware lowering and emit are deferred.
        var stream = BindExpression(syntax.Stream);
        if (stream is BoundErrorExpression)
        {
            return new BoundExpressionStatement(syntax, stream);
        }

        if (!TryGetAsyncEnumerableElementType(stream.Type, out var elementType))
        {
            Diagnostics.ReportTypeIsNotAsyncEnumerable(syntax.Stream.Location, stream.Type);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        scope = new BoundScope(scope);
        var variable = BindVariableDeclaration(syntax.Identifier, isReadOnly: false, type: elementType);
        var body = BindStatement(syntax.Body);
        scope = scope.Parent;

        return new BoundAwaitForRangeStatement(null, variable, stream, body);
    }

    private BoundStatement BindYieldStatement(YieldStatementSyntax syntax)
    {
        // ADR-0040: `yield <expr>` — only valid in an iterator function.
        if (function == null || !IsIteratorReturnType(function.Type))
        {
            Diagnostics.ReportYieldOutsideIteratorFunction(syntax.YieldKeyword.Location);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var elementType = GetIteratorElementType(function.Type);
        var expression = BindExpression(syntax.Expression);
        if (expression.Type != null && elementType != null && expression.Type != elementType)
        {
            expression = BindConversion(syntax.Expression.Location, expression, elementType);
        }

        return new BoundYieldStatement(syntax, expression);
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

    private static TypeSymbol GetIteratorElementType(TypeSymbol type)
    {
        if (type is SequenceTypeSymbol seq)
        {
            return seq.ElementType;
        }

        var clr = type?.ClrType;
        if (clr == null)
        {
            return TypeSymbol.FromClrType(typeof(object));
        }

        if (clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var def = clr.GetGenericTypeDefinition();
            if (def == typeof(System.Collections.Generic.IEnumerable<>) ||
                def == typeof(System.Collections.Generic.IEnumerator<>))
            {
                return TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
            }

            // Async iterators: IAsyncEnumerable<T> / IAsyncEnumerator<T>
            if (def.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IAsyncEnumerator`1")
            {
                return TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
            }
        }

        return TypeSymbol.FromClrType(typeof(object));
    }

    private static bool TryGetAsyncEnumerableElementType(TypeSymbol type, out TypeSymbol elementType)
    {
        elementType = null;
        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        foreach (var iface in EnumerateSelfAndInterfaces(clr))
        {
            if (iface.IsGenericType &&
                !iface.IsGenericTypeDefinition &&
                iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IAsyncEnumerable`1")
            {
                elementType = TypeSymbol.FromClrType(iface.GetGenericArguments()[0]);
                return true;
            }
        }

        return false;
    }

    private static System.Collections.Generic.IEnumerable<System.Type> EnumerateSelfAndInterfaces(System.Type t)
    {
        yield return t;
        foreach (var i in t.GetInterfaces())
        {
            yield return i;
        }
    }

    private TypeSymbol ResolveExceptionType()
    {
        if (scope.References.TryResolveType("System.Exception", out var t))
        {
            return TypeSymbol.FromClrType(t);
        }

        return null;
    }

    private BoundStatement BindForInfiniteStatement(ForInfiniteStatementSyntax syntax)
    {
        scope = new BoundScope(scope);

        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForInfiniteStatement(null, body, breakLabel, continueLabel);
    }

    private BoundStatement BindForEllipsisStatement(ForEllipsisStatementSyntax syntax)
    {
        var lowerBound = BindExpression(syntax.LowerBound, TypeSymbol.Int32);
        var upperBound = BindExpression(syntax.UpperBound, TypeSymbol.Int32);

        scope = new BoundScope(scope);

        var variable = BindVariableDeclaration(syntax.Identifier, isReadOnly: false, type: TypeSymbol.Int32);
        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForEllipsisStatement(null, variable, lowerBound, upperBound, body, breakLabel, continueLabel);
    }

    private BoundStatement BindForRangeStatement(ForRangeStatementSyntax syntax)
    {
        var collection = BindExpression(syntax.Collection);

        // Decide iteration strategy and element/key types based on the
        // collection type.
        ForRangeKind iterationKind;
        TypeSymbol keyType;
        TypeSymbol valueType;
        switch (collection.Type)
        {
            case ArrayTypeSymbol arr:
                iterationKind = ForRangeKind.Indexed;
                keyType = TypeSymbol.Int32;
                valueType = arr.ElementType;
                break;
            case SliceTypeSymbol slice:
                iterationKind = ForRangeKind.Indexed;
                keyType = TypeSymbol.Int32;
                valueType = slice.ElementType;
                break;

            // Issue #209: NullabilityAnnotatedTypeSymbol carries inner-position nullable
            // flags; extract element/key/value types using those flags so that
            // `for k, v := range dict` sees the proper nullable types.
            case NullabilityAnnotatedTypeSymbol annotated when annotated.ClrType != null:
                if (TryGetClrDictionaryTypes(annotated.ClrType, out var aDKey, out var aDVal))
                {
                    iterationKind = ForRangeKind.Dictionary;
                    keyType = annotated.GetTypeArgumentSymbolForClrType(aDKey);
                    valueType = annotated.GetTypeArgumentSymbolForClrType(aDVal);
                }
                else if (TryGetClrEnumerableElementType(annotated.ClrType, out var aElemType))
                {
                    iterationKind = ForRangeKind.Enumerable;
                    keyType = TypeSymbol.Int32;
                    valueType = annotated.GetTypeArgumentSymbolForClrType(aElemType);
                }
                else if (TryGetClrPatternEnumerableElementType(annotated.ClrType, out var aPatternElemType))
                {
                    iterationKind = ForRangeKind.PatternEnumerator;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(aPatternElemType);
                }
                else
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                    return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
                }

                break;
            case ImportedTypeSymbol imp when imp.ClrType != null:
                if (TryGetClrDictionaryTypes(imp.ClrType, out var dKey, out var dVal))
                {
                    iterationKind = ForRangeKind.Dictionary;
                    keyType = TypeSymbol.FromClrType(dKey);
                    valueType = TypeSymbol.FromClrType(dVal);
                }
                else if (TryGetClrEnumerableElementType(imp.ClrType, out var elemType))
                {
                    iterationKind = ForRangeKind.Enumerable;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(elemType);
                }
                else if (TryGetClrPatternEnumerableElementType(imp.ClrType, out var patternElemType))
                {
                    iterationKind = ForRangeKind.PatternEnumerator;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(patternElemType);
                }
                else
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                    return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
                }

                break;
            case StructSymbol userType when TryGetUserPatternEnumerableElementType(userType, out var userElemType):
                iterationKind = ForRangeKind.PatternEnumerator;
                keyType = TypeSymbol.Int32;
                valueType = userElemType;
                break;
            case SequenceTypeSymbol seq:
                // ADR-0040: sequence[T] is IEnumerable[T] — iterate via Enumerable strategy.
                iterationKind = ForRangeKind.Enumerable;
                keyType = TypeSymbol.Int32;
                valueType = seq.ElementType;
                break;
            default:
                if (collection.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                }

                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        scope = new BoundScope(scope);

        VariableSymbol keyVariable = null;
        VariableSymbol valueVariable;
        if (syntax.SecondIdentifier != null)
        {
            keyVariable = BindVariableDeclaration(syntax.FirstIdentifier, isReadOnly: false, type: keyType);
            valueVariable = BindVariableDeclaration(syntax.SecondIdentifier, isReadOnly: false, type: valueType);
        }
        else
        {
            // `for v := range coll` — single var binds the value/element.
            valueVariable = BindVariableDeclaration(syntax.FirstIdentifier, isReadOnly: false, type: valueType);
        }

        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForRangeStatement(syntax, keyVariable, valueVariable, collection, iterationKind, body, breakLabel, continueLabel);
    }

    private static bool TryGetClrDictionaryTypes(System.Type clrType, out System.Type keyType, out System.Type valueType)
    {
        foreach (var iface in EnumerateSelfAndInterfaces(clrType))
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IDictionary`2")
            {
                var args = iface.GetGenericArguments();
                keyType = args[0];
                valueType = args[1];
                return true;
            }
        }

        keyType = null;
        valueType = null;
        return false;
    }

    private static bool TryGetClrEnumerableElementType(System.Type clrType, out System.Type elementType)
    {
        foreach (var iface in EnumerateSelfAndInterfaces(clrType))
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IEnumerable`1")
            {
                elementType = iface.GetGenericArguments()[0];
                return true;
            }
        }

        // Non-generic IEnumerable falls back to object.
        if (typeof(System.Collections.IEnumerable).IsAssignableFrom(clrType))
        {
            elementType = typeof(object);
            return true;
        }

        elementType = null;
        return false;
    }

    private static bool TryGetClrPatternEnumerableElementType(System.Type clrType, out System.Type elementType)
    {
        var getEnumerator = clrType.GetMethod(
            "GetEnumerator",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
            binder: null,
            types: System.Type.EmptyTypes,
            modifiers: null);
        if (getEnumerator == null)
        {
            elementType = null;
            return false;
        }

        var enumeratorType = getEnumerator.ReturnType;
        var moveNext = enumeratorType.GetMethod(
            "MoveNext",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
            binder: null,
            types: System.Type.EmptyTypes,
            modifiers: null);
        if (moveNext?.ReturnType != typeof(bool))
        {
            elementType = null;
            return false;
        }

        if (TryGetClrCurrentMemberType(enumeratorType, out elementType))
        {
            return true;
        }

        elementType = null;
        return false;
    }

    private static bool TryGetClrCurrentMemberType(System.Type enumeratorType, out System.Type elementType)
    {
        var currentProperty = enumeratorType.GetProperty("Current", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public);
        if (currentProperty != null)
        {
            elementType = currentProperty.PropertyType;
            return true;
        }

        var currentField = enumeratorType.GetField("Current", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public);
        if (currentField != null)
        {
            elementType = currentField.FieldType;
            return true;
        }

        elementType = null;
        return false;
    }

    private static bool TryGetUserPatternEnumerableElementType(StructSymbol type, out TypeSymbol elementType)
    {
        if (type.TryGetMethodIncludingInherited("GetEnumerator", out var getEnumerator) &&
            getEnumerator.Parameters.Length == 0 &&
            getEnumerator.Type is StructSymbol enumeratorType &&
            enumeratorType.TryGetMethodIncludingInherited("MoveNext", out var moveNext) &&
            moveNext.Parameters.Length == 0 &&
            moveNext.Type == TypeSymbol.Bool &&
            enumeratorType.TryGetField("Current", out var currentField))
        {
            elementType = currentField.Type;
            return true;
        }

        elementType = null;
        return false;
    }

    private BoundStatement BindForConditionStatement(ForConditionStatementSyntax syntax)
    {
        // Lowers to:
        //   {
        //     goto checkLabel
        //     bodyLabel:
        //     <body>
        //     continueLabel:
        //     checkLabel:
        //     if cond goto bodyLabel
        //     breakLabel:
        //   }
        scope = new BoundScope(scope);

        var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);
        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        var bodyLabel = new BoundLabel($"body{labelCounter}");
        var checkLabel = new BoundLabel($"check{labelCounter}");

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundGotoStatement(syntax, checkLabel));
        statements.Add(new BoundLabelStatement(syntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(syntax, continueLabel));
        statements.Add(new BoundLabelStatement(syntax, checkLabel));
        statements.Add(new BoundConditionalGotoStatement(syntax, bodyLabel, condition, jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(syntax, breakLabel));

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private BoundStatement BindForClauseStatement(ForClauseStatementSyntax syntax)
    {
        // Lowers to:
        //   {
        //     <init>?
        //     goto checkLabel
        //     bodyLabel:
        //     <body>
        //     continueLabel:
        //     <post>?
        //     checkLabel:
        //     [if cond] goto bodyLabel
        //     breakLabel:
        //   }
        scope = new BoundScope(scope);

        var init = syntax.Initializer == null ? null : BindStatement(syntax.Initializer);
        var condition = syntax.Condition == null ? null : BindExpression(syntax.Condition, TypeSymbol.Bool);
        var post = syntax.Post == null ? null : BindStatement(syntax.Post);
        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        var bodyLabel = new BoundLabel($"body{labelCounter}");
        var checkLabel = new BoundLabel($"check{labelCounter}");

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        if (init != null)
        {
            statements.Add(init);
        }

        statements.Add(new BoundGotoStatement(syntax, checkLabel));
        statements.Add(new BoundLabelStatement(syntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(syntax, continueLabel));
        if (post != null)
        {
            statements.Add(post);
        }

        statements.Add(new BoundLabelStatement(syntax, checkLabel));
        if (condition == null)
        {
            statements.Add(new BoundGotoStatement(syntax, bodyLabel));
        }
        else
        {
            statements.Add(new BoundConditionalGotoStatement(syntax, bodyLabel, condition, jumpIfTrue: true));
        }

        statements.Add(new BoundLabelStatement(syntax, breakLabel));

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private BoundStatement BindLoopBody(StatementSyntax body, out BoundLabel breakLabel, out BoundLabel continueLabel)
    {
        labelCounter++;
        breakLabel = new BoundLabel($"break{labelCounter}");
        continueLabel = new BoundLabel($"continue{labelCounter}");

        loopStack.Push((breakLabel, continueLabel));
        var boundBody = BindStatement(body);
        loopStack.Pop();

        return boundBody;
    }

    private BoundStatement BindBreakStatement(BreakStatementSyntax syntax)
    {
        if (loopStack.Count == 0)
        {
            Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text);
            return BindErrorStatement();
        }

        var breakLabel = loopStack.Peek().BreakLabel;
        return new BoundGotoStatement(syntax, breakLabel);
    }

    private BoundStatement BindContinueStatement(ContinueStatementSyntax syntax)
    {
        if (loopStack.Count == 0)
        {
            Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text);
            return BindErrorStatement();
        }

        var continueLabel = loopStack.Peek().ContinueLabel;
        return new BoundGotoStatement(syntax, continueLabel);
    }

    private BoundStatement BindReturnStatement(ReturnStatementSyntax syntax)
    {
        var expression = syntax.Expression == null ? null : BindExpression(syntax.Expression);

        if (function == null)
        {
            Diagnostics.ReportInvalidReturn(syntax.ReturnKeyword.Location);
        }
        else
        {
            if (function.Type == TypeSymbol.Void)
            {
                if (expression != null)
                {
                    Diagnostics.ReportInvalidReturnExpression(syntax.Expression.Location, function.Name);
                }
            }
            else
            {
                if (expression == null)
                {
                    Diagnostics.ReportMissingReturnExpression(syntax.ReturnKeyword.Location, function.Type);
                }
                else
                {
                    expression = BindConversion(syntax.Expression.Location, expression, function.Type);
                }
            }
        }

        return new BoundReturnStatement(syntax, expression);
    }

    private BoundStatement BindExpressionStatement(ExpressionStatementSyntax syntax)
    {
        var expression = BindExpression(syntax.Expression, canBeVoid: true);
        return new BoundExpressionStatement(syntax, expression);
    }

    private BoundExpression BindExpression(ExpressionSyntax syntax, TypeSymbol targetType)
    {
        return BindConversion(syntax, targetType);
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
                return BindCallExpression((CallExpressionSyntax)syntax);
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
            case SyntaxKind.StructLiteralExpression:
                return BindStructLiteralExpression((StructLiteralExpressionSyntax)syntax);
            case SyntaxKind.TupleLiteralExpression:
                return BindTupleLiteralExpression((TupleLiteralExpressionSyntax)syntax);
            case SyntaxKind.FunctionLiteralExpression:
                return BindFunctionLiteralExpression((FunctionLiteralExpressionSyntax)syntax);
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
        // Lower `"a $x b ${expr} c"` to a `+`-chain of string-typed sub-
        // expressions: literal parts become string literals; expression parts
        // are bound recursively and, when not already string-typed, wrapped in
        // an instance `.ToString()` call. An empty interpolation collapses to
        // the empty-string literal.
        BoundExpression result = null;
        foreach (var segment in syntax.Segments)
        {
            BoundExpression piece;
            if (segment.IsExpression)
            {
                var bound = BindExpression(segment.Expression);
                if (bound is BoundErrorExpression)
                {
                    return bound;
                }

                piece = ConvertToString(bound, segment.Expression.Location);
                if (piece is BoundErrorExpression)
                {
                    return piece;
                }
            }
            else
            {
                piece = new BoundLiteralExpression(null, segment.Text ?? string.Empty);
            }

            result = result == null ? piece : Concat(result, piece);
        }

        return result ?? new BoundLiteralExpression(null, string.Empty);
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

        return new BoundVariableExpression(null, variable, TryGetNarrowedType(variable));
    }

    private TypeSymbol TryGetNarrowedType(VariableSymbol variable)
    {
        // Phase 3.C.4: smart-cast narrowing map. Walk the active stack from
        // innermost frame outward — the topmost narrowing wins.
        for (var i = narrowedVariables.Count - 1; i >= 0; i--)
        {
            if (narrowedVariables[i].TryGetValue(variable, out var narrowed))
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

            var convertedValue = BindConversion(syntax.Expression.Location, boundExpression, implicitField.Field.Type);
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

            var convertedValue = BindConversion(syntax.Expression.Location, boundExpression, implicitStaticField.Field.Type);
            return new BoundFieldAssignmentExpression(null, null, implicitStaticField.StructType, implicitStaticField.Field, convertedValue);
        }

        if (variable.IsReadOnly)
        {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
        }

        var convertedExpression = BindConversion(syntax.Expression.Location, boundExpression, variable.Type);

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

        var tempName = "$copy" + System.Threading.Interlocked.Increment(ref syntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
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
            valueExpr = BindConversion(initSyntax.Value.Location, valueExpr, field.Type);
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
            valueExpr = BindConversion(initSyntax.Value.Location, valueExpr, field.Type);
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

    private BoundExpression BindFunctionLiteralExpression(FunctionLiteralExpressionSyntax syntax)
    {
        // Phase 4.7: function literal `[async] func(p1 T1, p2 T2) R { body }`.
        // Bind parameters, push a new scope chained to the current scope so
        // outer locals are visible by lexical lookup (closure capture), bind
        // the body against a synthetic FunctionSymbol whose return type is
        // the declared return clause (or void), then collect the captured
        // outer variables by inspecting the bound body.
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.Parameters.Count);
        var parameterSymbols = ImmutableArray.CreateBuilder<ParameterSymbol>(syntax.Parameters.Count);
        var seen = new HashSet<string>();
        foreach (var p in syntax.Parameters)
        {
            var pname = p.Identifier.Text;
            var ptype = BindTypeClause(p.Type) ?? TypeSymbol.Error;
            if (p.IsVariadic)
            {
                Diagnostics.ReportVariadicParameterNotSupportedHere(p.Location, pname);
            }

            if (!seen.Add(pname))
            {
                Diagnostics.ReportParameterAlreadyDeclared(p.Location, pname);
            }

            parameterSymbols.Add(new ParameterSymbol(pname, ptype, declaringSyntax: p.Identifier));
            parameterTypes.Add(ptype);
        }

        var returnType = syntax.ReturnTypeClause != null ? BindReturnTypeClause(syntax.ReturnTypeClause, syntax.IsAsync) : TypeSymbol.Void;
        returnType ??= TypeSymbol.Void;

        // For async lambdas, the observable return type (from the caller's
        // perspective) is Task or Task<T>, matching top-level async functions —
        // with the iterator carve-out (ADR-0041): an async iterator lambda
        // returning IAsyncEnumerable[T] does not get a Task wrap.
        var observableReturnType = returnType;
        if (syntax.IsAsync && !IsAsyncIteratorReturnType(returnType))
        {
            observableReturnType = WrapAsTask(returnType);
        }

        var fnType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), observableReturnType);
        var synthetic = new FunctionSymbol(
            $"<lambda{System.Threading.Interlocked.Increment(ref syntheticLocalCounter)}>",
            parameterSymbols.ToImmutable(),
            returnType);
        synthetic.IsAsync = syntax.IsAsync;

        // Snapshot current binder state, then push a child scope and bind
        // the body as if we were inside this synthetic function.
        var outerScope = scope;
        var outerFunction = function;
        scope = new BoundScope(outerScope);
        function = synthetic;
        foreach (var ps in synthetic.Parameters)
        {
            scope.TryDeclareVariable(ps);
        }

        var body = BindBlockStatement(syntax.Body);

        scope = outerScope;
        function = outerFunction;

        var captured = CollectCapturedVariables(body, synthetic.Parameters);
        return new BoundFunctionLiteralExpression(null, synthetic, fnType, (BoundBlockStatement)body, captured);
    }

    private static ImmutableArray<VariableSymbol> CollectCapturedVariables(BoundStatement body, ImmutableArray<ParameterSymbol> parameters)
    {
        var paramSet = new HashSet<VariableSymbol>(parameters);
        var seen = new HashSet<VariableSymbol>();
        var captured = ImmutableArray.CreateBuilder<VariableSymbol>();
        var collector = new CapturedVariableCollector(paramSet, seen, captured);
        collector.RewriteStatement(body);
        return captured.ToImmutable();
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

            if (!TryGetWritableClrMember(staticMember, out var staticTargetType, out var staticWritable))
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.Text);
                return new BoundErrorExpression(null);
            }

            _ = staticWritable;
            var staticConverted = BindConversion(syntax.Value.Location, staticValue, TypeSymbol.FromClrType(staticTargetType));
            return new BoundClrPropertyAssignmentExpression(null, receiver: null, staticMember, staticConverted, TypeSymbol.FromClrType(staticTargetType));
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

                var staticConverted = BindConversion(syntax.Value.Location, staticValue, staticField.Type);
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

                    var propConverted = BindConversion(syntax.Value.Location, staticValue, prop.Type);
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
            MemberInfo instanceMember = clrReceiverType.GetProperty(fieldName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember is PropertyInfo prop && prop.GetIndexParameters().Length != 0)
            {
                instanceMember = null;
            }

            instanceMember ??= clrReceiverType.GetField(fieldName, BindingFlags.Public | BindingFlags.Instance);
            if (instanceMember == null)
            {
                Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, fieldName);
                return new BoundErrorExpression(null);
            }

            if (!TryGetWritableClrMember(instanceMember, out var instTargetType, out var instWritable))
            {
                Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, fieldName);
                return new BoundErrorExpression(null);
            }

            _ = instWritable;
            var instReceiver = new BoundVariableExpression(null, variable);
            var instConverted = BindConversion(syntax.Value.Location, value, TypeSymbol.FromClrType(instTargetType));
            return new BoundClrPropertyAssignmentExpression(null, instReceiver, instanceMember, instConverted, TypeSymbol.FromClrType(instTargetType));
        }

        if (!(variable.Type is StructSymbol structSymbol))
        {
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        if (!structSymbol.TryGetFieldIncludingInherited(syntax.FieldIdentifier.Text, out var field, out _))
        {
            // ADR-0051: check if it's a property.
            if (TryGetPropertyIncludingInherited(structSymbol, syntax.FieldIdentifier.Text, out var prop))
            {
                if (!prop.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, syntax.FieldIdentifier.Text);
                    return new BoundErrorExpression(null);
                }

                var propConverted = BindConversion(syntax.Value.Location, value, prop.Type);
                return new BoundPropertyAssignmentExpression(null, new BoundVariableExpression(null, variable), structSymbol, prop, propConverted);
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

        var converted = BindConversion(syntax.Value.Location, value, field.Type);
        return new BoundFieldAssignmentExpression(null, variable, structSymbol, field, converted);
    }

    private BoundExpression BindEventSubscriptionExpression(EventSubscriptionExpressionSyntax syntax)
    {
        // Stream B′: `lhs.Event += handler` / `lhs.Event -= handler`.
        // The parser guarantees LeftHandSide is an AccessorExpressionSyntax.
        if (syntax.LeftHandSide is not AccessorExpressionSyntax accessor)
        {
            Diagnostics.ReportUnableToFindMember(syntax.LeftHandSide.Location, syntax.OperatorToken.Text);
            return new BoundErrorExpression(null);
        }

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
            && staticTypeAlias is StructSymbol staticStruct
            && !staticStruct.StaticEvents.IsDefaultOrEmpty)
        {
            // Issue #263: static event subscription on a user-defined type.
            var ev = staticStruct.StaticEvents.FirstOrDefault(e => e.Name == eventName);
            if (ev != null)
            {
                var userHandler = BindExpression(syntax.Value);
                return new BoundEventSubscriptionExpression(null, receiver: null, staticStruct, ev, userHandler, isAdd);
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
                    var userHandler = BindExpression(syntax.Value);
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

        var eventInfo = receiverClrType.GetEvent(eventName, flags);
        if (eventInfo == null)
        {
            Diagnostics.ReportUnableToFindMember(eventNameSyntax.Location, eventName);
            return new BoundErrorExpression(null);
        }

        var handlerType = eventInfo.EventHandlerType;
        var boundHandler = BindExpression(syntax.Value);

        // The handler is most useful when expressed as a function literal of
        // matching signature. For that path we skip BindConversion (which has
        // no generic fn → custom-delegate rule) and rely on the evaluator /
        // emitter to materialize the right delegate type. Otherwise fall back
        // to the standard conversion (covers null, already-typed delegate
        // variables, etc.).
        BoundExpression convertedHandler;
        if (boundHandler.Type is FunctionTypeSymbol fn
            && IsSignatureCompatibleWithDelegate(fn, handlerType))
        {
            convertedHandler = boundHandler;
        }
        else
        {
            var handlerSymbol = TypeSymbol.FromClrType(handlerType);
            convertedHandler = BindConversion(syntax.Value.Location, boundHandler, handlerSymbol);
        }

        return new BoundClrEventSubscriptionExpression(null, boundReceiver, eventInfo, convertedHandler, isAdd);
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

    private static bool TryGetWritableClrMember(MemberInfo member, out Type targetType, out bool writable)
    {
        switch (member)
        {
            case PropertyInfo p:
                targetType = p.PropertyType;
                writable = p.CanWrite && p.GetSetMethod(nonPublic: false) != null;
                return writable;
            case FieldInfo f:
                targetType = f.FieldType;
                writable = !f.IsInitOnly && !f.IsLiteral;
                return writable;
            default:
                targetType = null;
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
                    var convertedOperand = BindConversion(syntax.Operand.Location, boundOperand, userOp.Parameters[0].Type);
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
        var operand = BindExpression(syntax.Operand);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        // GS9005: cannot take address of a constant binding.
        if (operand is BoundVariableExpression bve && bve.Variable.IsReadOnly)
        {
            Diagnostics.ReportCannotTakeAddressOfConstant(syntax.OperatorToken.Location, bve.Variable.Name);
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

    /// <summary>ADR-0039: Determines whether an expression is an lvalue (can have its address taken).</summary>
    private static bool IsLvalue(BoundExpression expression)
    {
        return expression is BoundVariableExpression
            or BoundFieldAccessExpression
            or BoundIndexExpression
            or BoundDereferenceExpression;
    }

    /// <summary>ADR-0039: Computes per-argument <see cref="RefKind"/> from CLR parameter metadata.</summary>
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

    /// <summary>
    /// Issue #327/#321: appends synthesized default-value arguments for any
    /// trailing optional parameters the call site omitted. <paramref name="parameters"/>
    /// is the full parameter list of the resolved CLR method/constructor;
    /// <paramref name="suppliedArguments"/> are the arguments already bound for
    /// the leading parameters (for instance/extension calls this includes the
    /// receiver mapped onto the first parameter). When no parameters are
    /// omitted, the supplied array is returned unchanged.
    /// </summary>
    /// <param name="suppliedArguments">Bound arguments mapped to the leading parameters.</param>
    /// <param name="parameters">The resolved method's full parameter list.</param>
    /// <returns>The argument array padded to the parameter count with defaults.</returns>
    private static ImmutableArray<BoundExpression> AppendOmittedOptionalArguments(
        ImmutableArray<BoundExpression> suppliedArguments,
        System.Reflection.ParameterInfo[] parameters)
    {
        if (suppliedArguments.Length >= parameters.Length)
        {
            return suppliedArguments;
        }

        var builder = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
        builder.AddRange(suppliedArguments);
        for (var i = suppliedArguments.Length; i < parameters.Length; i++)
        {
            builder.Add(CreateOptionalDefaultArgument(parameters[i]));
        }

        return builder.MoveToImmutable();
    }

    /// <summary>
    /// Issue #327/#321: builds the bound expression for an omitted optional
    /// parameter. An explicit constant default (e.g. <c>int x = 5</c>) becomes
    /// the corresponding literal; <c>= default</c>/<c>= null</c> and
    /// constant-less <c>[Optional]</c> parameters (e.g.
    /// <c>CancellationToken cancellationToken = default</c>) become the zero
    /// value of the parameter type.
    /// </summary>
    /// <param name="parameter">The omitted optional parameter.</param>
    /// <returns>The bound default-value argument.</returns>
    private static BoundExpression CreateOptionalDefaultArgument(System.Reflection.ParameterInfo parameter)
    {
        var typeSymbol = TypeSymbol.FromClrType(parameter.ParameterType);

        if (TryGetConstantParameterDefault(parameter, out var constant))
        {
            return new BoundLiteralExpression(null, constant);
        }

        return new BoundDefaultExpression(null, typeSymbol);
    }

    /// <summary>
    /// Issue #327: reads a primitive/string constant default from an optional
    /// parameter's metadata, when present. Returns <c>false</c> for
    /// <c>= default</c>, <c>= null</c>, or non-primitive constants so the caller
    /// falls back to <see cref="BoundDefaultExpression"/>.
    /// </summary>
    /// <param name="parameter">The optional parameter to inspect.</param>
    /// <param name="value">The constant default value, when present.</param>
    /// <returns>Whether a usable primitive/string constant default exists.</returns>
    private static bool TryGetConstantParameterDefault(System.Reflection.ParameterInfo parameter, out object value)
    {
        value = null;
        object raw;
        try
        {
            raw = parameter.RawDefaultValue;
        }
        catch
        {
            return false;
        }

        if (raw == null || raw is System.DBNull)
        {
            return false;
        }

        // Only primitive/string constants flow through BoundLiteralExpression's
        // known value kinds; the constant's CLR type is also the IL form for an
        // enum parameter (whose default is encoded as its underlying integral).
        switch (raw)
        {
            case bool:
            case sbyte:
            case byte:
            case short:
            case ushort:
            case int:
            case uint:
            case long:
            case ulong:
            case float:
            case double:
            case char:
            case string:
                value = raw;
                return true;
            default:
                return false;
        }
    }

    /// <summary>ADR-0039: Validates that ref/out arguments are wrapped in <c>BoundAddressOfExpression</c>.</summary>
    private ImmutableArray<BoundExpression> ValidateRefArguments(
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> refKinds,
        string methodName,
        TextLocation callLocation)
    {
        if (refKinds.IsDefault || refKinds.Length == 0)
        {
            return arguments;
        }

        var builder = arguments.ToBuilder();
        for (int i = 0; i < refKinds.Length && i < arguments.Length; i++)
        {
            var rk = refKinds[i];
            if (rk == RefKind.None)
            {
                continue;
            }

            if (rk == RefKind.Ref || rk == RefKind.Out)
            {
                if (arguments[i] is not BoundAddressOfExpression)
                {
                    Diagnostics.ReportArgumentMustBePassedByRef(callLocation, i + 1, methodName);
                }
            }

            // For `in`: accept either &expr or plain value (emitter spills temp).
        }

        return builder.ToImmutable();
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
                    var convertedLeft = BindConversion(syntax.Left.Location, boundLeft, userOp.Parameters[0].Type);
                    var convertedRight = BindConversion(syntax.Right.Location, boundRight, userOp.Parameters[1].Type);
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

    private BoundExpression BindConstructorCallExpression(CallExpressionSyntax syntax, StructSymbol classType)
    {
        // ADR-0047 §6 / #175: primary-constructor call `Foo(...)` is a
        // use of the class type itself.
        ReportObsoleteUseIfApplicable(syntax.Identifier.Location, classType, classType.Name);

        // Issue #306: a class declaring an explicit `init(...)` constructor is
        // constructed against that constructor's parameter list rather than a
        // primary-constructor parameter list.
        if (classType.ExplicitConstructor != null)
        {
            return BindExplicitConstructorCallExpression(syntax, classType);
        }

        // Phase 4.3b / ADR-0020: a primary-constructor call on a generic
        // class definition (`Box(5)` or `Box[int](5)`) builds a type-argument
        // substitution before resolving the parameter list against the
        // user-supplied arguments. Explicit `[…]` wins; otherwise we infer
        // from value-argument types against the definition's primary-ctor
        // parameter types (first-seen-wins, same rule as 4.1 call sites).
        if (classType.IsGenericDefinition)
        {
            var tps = classType.TypeParameters;
            var defParams = classType.PrimaryConstructorParameters;
            var substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            if (syntax.TypeArgumentList != null)
            {
                var explicitArgs = syntax.TypeArgumentList.Arguments;
                if (explicitArgs.Count != tps.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, classType.Name, tps.Length, explicitArgs.Count);
                    return new BoundErrorExpression(syntax);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = BindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(syntax);
                    }

                    substitution[tps[i]] = ta;
                }
            }
            else
            {
                // Pre-bind arguments and infer type arguments from them.
                for (var i = 0; i < syntax.Arguments.Count && i < defParams.Length; i++)
                {
                    var preBound = BindExpression(syntax.Arguments[i]);
                    InferTypeArguments(defParams[i].Type, preBound.Type, substitution);
                }

                foreach (var tp in tps)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(syntax.Identifier.Location, classType.Name, tp.Name);
                        return new BoundErrorExpression(syntax);
                    }
                }
            }

            var constraintLocation = syntax.TypeArgumentList != null
                ? syntax.TypeArgumentList.Location
                : syntax.Identifier.Location;
            foreach (var tp in tps)
            {
                var typeArg = substitution[tp];
                if (!SatisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, DescribeConstraint(tp));
                    return new BoundErrorExpression(syntax);
                }
            }

            var typeArgs = ImmutableArray.CreateBuilder<TypeSymbol>(tps.Length);
            foreach (var tp in tps)
            {
                typeArgs.Add(substitution[tp]);
            }

            classType = StructSymbol.Construct(classType, typeArgs.MoveToImmutable());
        }
        else if (syntax.TypeArgumentList != null)
        {
            Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, classType.Name, 0, syntax.TypeArgumentList.Arguments.Count);
            return new BoundErrorExpression(syntax);
        }

        var parameters = classType.PrimaryConstructorParameters;
        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        foreach (var argument in syntax.Arguments)
        {
            boundArguments.Add(BindExpression(argument));
        }

        if (syntax.Arguments.Count != parameters.Length)
        {
            TextSpan span;
            if (syntax.Arguments.Count > parameters.Length)
            {
                SyntaxNode firstExceedingNode;
                if (parameters.Length > 0)
                {
                    firstExceedingNode = syntax.Arguments.GetSeparator(parameters.Length - 1);
                }
                else
                {
                    firstExceedingNode = syntax.Arguments[0];
                }

                var lastExceedingArgument = syntax.Arguments[syntax.Arguments.Count - 1];
                span = TextSpan.FromBounds(firstExceedingNode.Span.Start, lastExceedingArgument.Span.End);
            }
            else
            {
                span = syntax.CloseParenthesisToken.Span;
            }

            Diagnostics.ReportWrongArgumentCount(new TextLocation(syntax.Location.Text, span), classType.Name, parameters.Length, syntax.Arguments.Count);
            return new BoundErrorExpression(syntax);
        }

        var hasErrors = false;
        for (var i = 0; i < parameters.Length; i++)
        {
            var argument = boundArguments[i];
            var parameter = parameters[i];
            if (argument.Type != parameter.Type
                && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit)
            {
                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(syntax.Arguments[i].Location, parameter.Name, parameter.Type, argument.Type);
                }

                hasErrors = true;
            }
        }

        if (hasErrors)
        {
            return new BoundErrorExpression(syntax);
        }

        if (!classType.IsClass)
        {
            var fieldInitializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>(parameters.Length);
            for (var i = 0; i < parameters.Length; i++)
            {
                if (classType.TryGetField(parameters[i].Name, out var field))
                {
                    fieldInitializers.Add(new BoundFieldInitializer(field, boundArguments[i]));
                }
            }

            return new BoundStructLiteralExpression(syntax, classType, fieldInitializers.ToImmutable());
        }

        return new BoundConstructorCallExpression(syntax, classType, boundArguments.ToImmutable());
    }

    /// <summary>
    /// Issue #306: binds a construction call <c>T(args)</c> to the class's explicit
    /// <c>init(...)</c> constructor, validating the argument count and applying
    /// argument conversions against the constructor's parameter list.
    /// </summary>
    private BoundExpression BindExplicitConstructorCallExpression(CallExpressionSyntax syntax, StructSymbol classType)
    {
        if (syntax.TypeArgumentList != null || classType.IsGenericDefinition)
        {
            Diagnostics.ReportGenericExplicitConstructorUnsupported(syntax.Identifier.Location, classType.Name);
            return new BoundErrorExpression(syntax);
        }

        var parameters = classType.ExplicitConstructor.Parameters;
        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        foreach (var argument in syntax.Arguments)
        {
            boundArguments.Add(BindExpression(argument));
        }

        if (syntax.Arguments.Count != parameters.Length)
        {
            Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, classType.Name, parameters.Length, syntax.Arguments.Count);
            return new BoundErrorExpression(syntax);
        }

        var hasErrors = false;
        var convertedArguments = ImmutableArray.CreateBuilder<BoundExpression>(parameters.Length);
        for (var i = 0; i < parameters.Length; i++)
        {
            var argument = boundArguments[i];
            var parameter = parameters[i];
            if (argument.Type != parameter.Type
                && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit)
            {
                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(syntax.Arguments[i].Location, parameter.Name, parameter.Type, argument.Type);
                }

                hasErrors = true;
                convertedArguments.Add(argument);
            }
            else
            {
                convertedArguments.Add(BindConversion(syntax.Arguments[i].Location, argument, parameter.Type));
            }
        }

        if (hasErrors)
        {
            return new BoundErrorExpression(syntax);
        }

        return new BoundConstructorCallExpression(syntax, classType, convertedArguments.ToImmutable());
    }

    private BoundExpression BindCallExpression(CallExpressionSyntax syntax)
    {
        // Phase 4-exit: prefer CLR class instantiation over the single-arg
        // conversion-call hijack below, so that `StringBuilder(16)` resolves
        // to a CLR ctor rather than `BindConversion(int → StringBuilder)`.
        // Also handles closed-generic imports (`List[int]()`,
        // `Dictionary[string, int]()`). Interpreter-only — resolves a
        // ConstructorInfo and emits BoundClrConstructorCallExpression.
        if (TryBindClrConstructorCall(syntax, out var clrCtorCall))
        {
            return clrCtorCall;
        }

        if (syntax.Arguments.Count == 1 && LookupType(syntax.Identifier.Text) is TypeSymbol type)
        {
            // A single-arg call to a primitive-typed name is a conversion
            // (`int(x)`, `string(x)`). Defer to BindConversion. For a class
            // type with a one-parameter primary constructor, treat it as a
            // ctor call instead.
            if (!(type is StructSymbol singleArgStruct && (singleArgStruct.IsClass || singleArgStruct.IsInline) && (singleArgStruct.HasPrimaryConstructor || singleArgStruct.ExplicitConstructor != null)))
            {
                // ADR-0047 §6 / #175: `Type(x)` as an explicit conversion
                // is still a use of the named type.
                ReportObsoleteUseIfApplicable(syntax.Identifier.Location, type, type.Name);
                return BindConversion(syntax.Arguments[0], type, allowExplicit: true);
            }
        }

        // Phase 3.B.3 sub-step 2: `ClassName(arg1, arg2, ...)` invokes the
        // class's primary constructor when the call target resolves to a
        // class type with a declared primary ctor.
        if (LookupType(syntax.Identifier.Text) is StructSymbol classType && (classType.IsClass || classType.IsInline) && (classType.HasPrimaryConstructor || classType.ExplicitConstructor != null))
        {
            return BindConstructorCallExpression(syntax, classType);
        }

        if (TryBindIntrinsicCall(syntax, out var intrinsic))
        {
            return intrinsic;
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();

        foreach (var argument in syntax.Arguments)
        {
            var boundArgument = BindExpression(argument);
            boundArguments.Add(boundArgument);
        }

        var symbol = scope.TryLookupSymbol(syntax.Identifier.Text);
        if (symbol == null)
        {
            Diagnostics.ReportUndefinedFunction(syntax.Identifier.Location, syntax.Identifier.Text);
            return new BoundErrorExpression(null);
        }

        // Phase 4.7: invoking a function-typed variable goes through the
        // indirect-call path. Sites like `add(1, 2)` where `add` is `let
        // add func(int, int) int = ...` reduce to BoundIndirectCallExpression.
        if (symbol is VariableSymbol variable && variable.Type is FunctionTypeSymbol fnType)
        {
            if (syntax.Arguments.Count != fnType.Arity)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, variable.Name, fnType.Arity, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }

            var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
            for (var i = 0; i < syntax.Arguments.Count; i++)
            {
                convertedArgs.Add(BindConversion(syntax.Arguments[i].Location, boundArguments[i], fnType.ParameterTypes[i]));
            }

            return new BoundIndirectCallExpression(null, new BoundVariableExpression(null, variable), fnType, convertedArgs.MoveToImmutable());
        }

        // #325: a variable whose type is a CLR delegate (e.g. `Func[int32,
        // int32]`, `RequestDelegate`) is callable with call syntax `f(x)`,
        // mirroring native func-typed variables. Lower the call to an
        // invocation of the delegate's `Invoke` method, identical in behavior
        // to the explicit `f.Invoke(x)` form.
        if (symbol is VariableSymbol delegateVar
            && delegateVar.Type?.ClrType is System.Type delegateClrType
            && ClrTypeUtilities.IsDelegateType(delegateClrType))
        {
            var receiver = new BoundVariableExpression(null, delegateVar);
            if (TryBindInheritedClrInstanceCall(receiver, delegateClrType, "Invoke", boundArguments.ToImmutable(), syntax, out var invokeCall))
            {
                return invokeCall;
            }

            var invoke = delegateClrType.GetMethod("Invoke");
            var expectedArity = invoke?.GetParameters().Length ?? 0;
            if (syntax.Arguments.Count != expectedArity)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, delegateVar.Name, expectedArity, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportNotAFunction(syntax.Identifier.Location, syntax.Identifier.Text);
            return new BoundErrorExpression(null);
        }

        var function = symbol as FunctionSymbol;
        if (function == null)
        {
            Diagnostics.ReportNotAFunction(syntax.Identifier.Location, syntax.Identifier.Text);
            return new BoundErrorExpression(null);
        }

        ReportObsoleteUseIfApplicable(syntax.Identifier.Location, function, function.Name);

        var isVariadic = function.Parameters.Length > 0 && function.Parameters[function.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? function.Parameters.Length - 1 : function.Parameters.Length;

        if (isVariadic)
        {
            if (syntax.Arguments.Count < fixedParamCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(syntax.Identifier.Location, function.Name, fixedParamCount, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }
        }
        else if (syntax.Arguments.Count != function.Parameters.Length)
        {
            TextSpan span;
            if (syntax.Arguments.Count > function.Parameters.Length)
            {
                SyntaxNode firstExceedingNode;
                if (function.Parameters.Length > 0)
                {
                    firstExceedingNode = syntax.Arguments.GetSeparator(function.Parameters.Length - 1);
                }
                else
                {
                    firstExceedingNode = syntax.Arguments[0];
                }

                var lastExceedingArgument = syntax.Arguments[syntax.Arguments.Count - 1];
                span = TextSpan.FromBounds(firstExceedingNode.Span.Start, lastExceedingArgument.Span.End);
            }
            else
            {
                span = syntax.CloseParenthesisToken.Span;
            }

            Diagnostics.ReportWrongArgumentCount(new TextLocation(syntax.Location.Text, span), function.Name, function.Parameters.Length, syntax.Arguments.Count);
            return new BoundErrorExpression(null);
        }

        bool hasErrors = false;

        // Phase 4.1 / ADR-0020: if the callee is generic, build the type
        // substitution either from the explicit `[T1, T2]` list at the call
        // site or by left-to-right inference from argument types matched
        // against parameter types.
        Dictionary<TypeParameterSymbol, TypeSymbol> substitution = null;
        if (function.IsGeneric)
        {
            substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            if (syntax.TypeArgumentList != null)
            {
                var explicitArgs = syntax.TypeArgumentList.Arguments;
                if (explicitArgs.Count != function.TypeParameters.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, function.Name, function.TypeParameters.Length, explicitArgs.Count);
                    return new BoundErrorExpression(null);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = BindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    substitution[function.TypeParameters[i]] = ta;
                }
            }
            else
            {
                for (var i = 0; i < function.Parameters.Length && i < boundArguments.Count; i++)
                {
                    InferTypeArguments(function.Parameters[i].Type, boundArguments[i].Type, substitution);
                }

                foreach (var tp in function.TypeParameters)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(syntax.Identifier.Location, function.Name, tp.Name);
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            var constraintLocation = syntax.TypeArgumentList != null
                ? syntax.TypeArgumentList.Location
                : syntax.Identifier.Location;
            foreach (var tp in function.TypeParameters)
            {
                var typeArg = substitution[tp];
                if (!SatisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, DescribeConstraint(tp));
                    return new BoundErrorExpression(null);
                }
            }
        }

        for (var i = 0; i < fixedParamCount; i++)
        {
            var argument = boundArguments[i];
            var parameter = function.Parameters[i];
            var expectedType = substitution != null ? SubstituteType(parameter.Type, substitution) : parameter.Type;

            if (argument.Type != expectedType
                && !(substitution != null && TypeSymbol.ContainsTypeParameter(parameter.Type))
                && !Conversion.Classify(argument.Type, expectedType).IsImplicit)
            {
                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(syntax.Arguments[i].Location, parameter.Name, expectedType, argument.Type);
                }

                hasErrors = true;
            }
        }

        // Phase 4.8: type-check trailing variadic arguments against the slice
        // element type, then pack them into a single slice-typed argument.
        if (isVariadic)
        {
            var variadicParam = function.Parameters[function.Parameters.Length - 1];
            var sliceType = (SliceTypeSymbol)variadicParam.Type;
            var elementType = sliceType.ElementType;
            for (var i = fixedParamCount; i < syntax.Arguments.Count; i++)
            {
                var argument = boundArguments[i];
                if (argument.Type != elementType && argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(syntax.Arguments[i].Location, variadicParam.Name, elementType, argument.Type);
                    hasErrors = true;
                }
            }

            if (!hasErrors)
            {
                var packed = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count - fixedParamCount);
                for (var i = fixedParamCount; i < syntax.Arguments.Count; i++)
                {
                    packed.Add(boundArguments[i]);
                }

                var finalArgs = ImmutableArray.CreateBuilder<BoundExpression>(fixedParamCount + 1);
                for (var i = 0; i < fixedParamCount; i++)
                {
                    finalArgs.Add(boundArguments[i]);
                }

                finalArgs.Add(new BoundArrayCreationExpression(syntax, sliceType, packed.MoveToImmutable()));
                boundArguments = finalArgs;
            }
        }

        if (hasErrors)
        {
            return new BoundErrorExpression(syntax);
        }

        if (substitution != null)
        {
            var returnType = SubstituteType(function.Type, substitution);
            if (function.IsAsync && !IsAsyncIteratorReturnType(function.Type))
            {
                returnType = WrapAsTask(returnType);
            }

            return CreatePossiblyElidedCall(function, boundArguments.ToImmutable(), returnType);
        }

        if (function.IsAsync && !IsAsyncIteratorReturnType(function.Type))
        {
            var asyncReturn = WrapAsTask(function.Type);
            return CreatePossiblyElidedCall(function, boundArguments.ToImmutable(), asyncReturn);
        }

        return CreatePossiblyElidedCall(function, boundArguments.ToImmutable(), returnType: null);
    }

    /// <summary>
    /// Constructs a <see cref="BoundCallExpression"/> for a direct function
    /// call, applying ADR-0047 §6 / issue #176 <c>[Conditional]</c> call-site
    /// elision. When elision applies, the resulting call carries an empty
    /// argument list (C# semantics: arguments to a conditional method are
    /// not evaluated when the symbol is undefined) and the
    /// <see cref="BoundCallExpression.IsConditionalElided"/> flag is set so
    /// the emitter and interpreter skip both argument evaluation and the
    /// method invocation. The validation that the function returns
    /// <c>void</c> was performed at declaration time (GS0212), so callers
    /// can rely on the elided call being a no-op of type <c>void</c>.
    /// Argument binding still ran above so wrong-type diagnostics on the
    /// elided arguments are reported normally.
    /// </summary>
    private BoundExpression CreatePossiblyElidedCall(FunctionSymbol function, ImmutableArray<BoundExpression> arguments, TypeSymbol returnType)
    {
        if (KnownAttributes.IsConditionallyElided(function.Attributes, scope.PreprocessorSymbols))
        {
            return new BoundCallExpression(null, function, ImmutableArray<BoundExpression>.Empty, returnType, isConditionalElided: true);
        }

        return new BoundCallExpression(null, function, arguments, returnType);
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

    private TypeSymbol WrapAsTask(TypeSymbol element)
    {
        if (element == TypeSymbol.Error)
        {
            return TypeSymbol.Error;
        }

        if (element == TypeSymbol.Void)
        {
            if (scope.References.TryResolveType("System.Threading.Tasks.Task", out var taskType))
            {
                return ImportedTypeSymbol.Get(taskType);
            }

            return element;
        }

        var clr = element.ClrType;
        if (clr == null)
        {
            // Phase 5.1 limitation (see ADR-0023): wrapping a user-defined
            // GSharp type as Task[T] requires interop work that is deferred.
            return element;
        }

        if (scope.References.TryResolveType("System.Threading.Tasks.Task`1", out var taskOpen))
        {
            // Route the element CLR type through the SAME resolver as Task`1.
            // Under the SDK build path the references are loaded via a
            // MetadataLoadContext, and MakeGenericType requires the type
            // argument to originate from that same context (issues #290 and
            // #291: value-returning async funcs and imported-Task<T> awaits).
            var elementClr = scope.References.MapClrTypeToReferences(clr);
            var closed = taskOpen.MakeGenericType(elementClr);
            return ImportedTypeSymbol.Get(closed);
        }

        return element;
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

                var element = BindConversion(syntax.Arguments[1], sliceType.ElementType);
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

                var keyExpr = BindConversion(syntax.Arguments[1], mapType.KeyType);
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

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            boundArguments.Add(BindExpression(syntax.Arguments[i]));
        }

        // Phase A (overload resolution): pick a constructor via the shared
        // "better function member" resolver. Ambiguity surfaces a hard
        // binder diagnostic and the call falls back to the surrounding
        // pipeline (which will diagnose a missing match).
        var ctors = clrType.GetConstructors(BindingFlags.Public | BindingFlags.Instance);
        var argTypes = new System.Type[boundArguments.Count];
        var argsAllTyped = true;
        for (var i = 0; i < boundArguments.Count; i++)
        {
            var t = boundArguments[i].Type?.ClrType;
            if (t == null)
            {
                argsAllTyped = false;
                break;
            }

            argTypes[i] = t;
        }

        ConstructorInfo bestCtor = null;
        if (argsAllTyped)
        {
            var resolution = OverloadResolution.Resolve(ctors, argTypes);
            switch (resolution.Outcome)
            {
                case OverloadResolution.ResolutionOutcome.Resolved:
                    bestCtor = resolution.Best;
                    break;
                case OverloadResolution.ResolutionOutcome.Ambiguous:
                    Diagnostics.ReportAmbiguousOverload(syntax.Location, clrType.Name, resolution.Ambiguous.Length);
                    return false;
                default:
                    break;
            }
        }

        if (bestCtor == null)
        {
            return false;
        }

        var ctorParameters = bestCtor.GetParameters();
        var ctorRefKinds = ComputeArgumentRefKinds(ctorParameters);
        var ctorArgs = AppendOmittedOptionalArguments(boundArguments.MoveToImmutable(), ctorParameters);
        if (!ctorRefKinds.IsDefault)
        {
            ValidateRefArguments(ctorArgs, ctorRefKinds, clrType.Name, syntax.Location);
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
        var captureName = "$ncap_" + (++nullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);

        // Bind the access using the capture as the receiver. We push a temp
        // scope so the capture is in scope for any nested name lookup that
        // happens during access binding (defensive — current accessor paths
        // don't look up the receiver by name).
        scope = new BoundScope(scope);
        scope.TryDeclareVariable(capture);

        var captureRef = new BoundVariableExpression(null, capture);
        var whenNotNull = BindAccessorStep(captureRef, null, syntax.RightPart);

        scope = scope.Parent;

        var resultType = whenNotNull.Type is NullableTypeSymbol ? whenNotNull.Type : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);
        return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, resultType);
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
            boundArguments.Add(BindExpression(argument));
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

                var expectedType = substitution != null ? SubstituteType(paramType, substitution) : paramType;
                convertedArgs.Add(BindConversion(ce.Arguments[i].Location, arguments[i], expectedType));
            }

            if (substitution != null)
            {
                var substitutedReturn = SubstituteType(method.Type, substitution);
                if (!ReferenceEquals(substitutedReturn, method.Type))
                {
                    return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), substitutedReturn);
                }
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

                return BindAccessorStep(head, null, nested.RightPart);

            case CallExpressionSyntax ce:
                return BindAccessorCall(receiver, classSymbol, ce);

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
                    if (TryGetPropertyIncludingInherited(structSym, ne.IdentifierToken.Text, out var prop))
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
                        var clrProp = inheritedBaseClr.GetProperty(memberName, BindingFlags.Public | BindingFlags.Instance);
                        if (clrProp != null && clrProp.GetIndexParameters().Length == 0 && clrProp.CanRead)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrProp, TypeSymbol.FromClrType(clrProp.PropertyType));
                        }

                        var clrFld = inheritedBaseClr.GetField(memberName, BindingFlags.Public | BindingFlags.Instance);
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
                else if (receiver != null && receiver.Type is not NullableTypeSymbol && receiver.Type.ClrType != null)
                {
                    // Phase 4 exit: read a public instance property or field on
                    // a CLR receiver (e.g. `lst.Count`, `sb.Length`,
                    // `kvp.Key`). Static members are reached through
                    // ImportedClassSymbol; this path covers instances. Nullable
                    // receivers must be narrowed or use `?.` before this path.
                    var clrReceiverType = receiver.Type.ClrType;
                    var memberName = ne.IdentifierToken.Text;
                    var prop = clrReceiverType.GetProperty(memberName, BindingFlags.Public | BindingFlags.Instance);
                    if (prop != null && prop.GetIndexParameters().Length == 0 && prop.CanRead)
                    {
                        return new BoundClrPropertyAccessExpression(null, receiver, prop, TypeSymbol.FromClrType(prop.PropertyType));
                    }

                    var fld = clrReceiverType.GetField(memberName, BindingFlags.Public | BindingFlags.Instance);
                    if (fld != null)
                    {
                        return new BoundClrPropertyAccessExpression(null, receiver, fld, TypeSymbol.FromClrType(fld.FieldType));
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
                resolved[i] = scope.References.MapClrTypeToReferences(ta.ClrType);
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

        if (hasNamedArguments)
        {
            Diagnostics.ReportNamedArgumentOnlyValidForCopy(ce.Location);
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var argument in ce.Arguments)
        {
            boundArguments.Add(BindExpression(argument));
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
            if (classSymbol.TryLookupFunction(methodName, ce, arguments, out var staticFn, out var staticAmbiguous, explicitTypeArgs, typeArgSymbols, scope.References.MapClrTypeToReferences))
            {
                var staticParameters = staticFn.Method.GetParameters();
                var staticArguments = AppendOmittedOptionalArguments(arguments, staticParameters);
                var refKinds = ComputeArgumentRefKinds(staticParameters);
                ValidateRefArguments(staticArguments, refKinds, methodName, ce.Location);
                return new BoundImportedCallExpression(null, staticFn, staticArguments, refKinds, typeArgSymbols);
            }

            if (staticAmbiguous)
            {
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, candidateCount: 2);
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        if (receiver == null || receiver.Type?.ClrType == null)
        {
            // Phase 3.B.4: dispatch to a user-defined interface method when
            // the static receiver type is an interface.
            if (receiver != null && receiver.Type is InterfaceSymbol ifaceRecv && ifaceRecv.TryGetMethod(methodName, out var ifaceMethod))
            {
                return BindUserInstanceCall(receiver, ifaceMethod, arguments, ce);
            }

            // Phase 4.2b / ADR-0020: dispatch through a type parameter's
            // sealed-interface constraint, just as if the receiver were
            // typed as the interface itself.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpRecv && tpRecv.InterfaceConstraint != null
                && tpRecv.InterfaceConstraint.TryGetMethod(methodName, out var tpIfaceMethod))
            {
                return BindUserInstanceCall(receiver, tpIfaceMethod, arguments, ce);
            }

            // Phase 3.B.3 sub-step 2b: dispatch to a user-defined class method
            // if receiver is a user struct symbol.
            if (receiver != null && receiver.Type is StructSymbol userClass && userClass.TryGetMethodIncludingInherited(methodName, out var userMethod))
            {
                return BindUserInstanceCall(receiver, userMethod, arguments, ce);
            }

            // Phase 3.B.6 / ADR-0019: extension function fallback for
            // user-type receivers (struct/class/interface).
            if (receiver != null && scope.TryLookupExtensionFunction(receiver.Type, methodName, out var userExtFn))
            {
                return BindExtensionFunctionCall(receiver, userExtFn, arguments, ce);
            }

            // Issue #296: a GSharp class inheriting an imported CLR base class
            // exposes the base's instance members. After user-defined and
            // extension lookups fail, resolve the call against the imported
            // base CLR type so inherited members are callable on the derived
            // GSharp instance. Inherited instance members take precedence over
            // imported extension methods.
            if (receiver != null && receiver.Type is StructSymbol inheritedDerived
                && inheritedDerived.ImportedBaseType?.ClrType is System.Type inheritedBaseClr
                && TryBindInheritedClrInstanceCall(receiver, inheritedBaseClr, methodName, arguments, ce, out var inheritedCall, explicitTypeArgs, typeArgSymbols))
            {
                return inheritedCall;
            }

            // Issue #294: imported [Extension] method dispatched with instance
            // (receiver) syntax, when the receiver carries a CLR type even
            // though its symbol is a user/interface shape.
            if (receiver != null && TryBindImportedExtensionCall(receiver, methodName, arguments, ce, out var userPathExt, explicitTypeArgs, typeArgSymbols))
            {
                return userPathExt;
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        // Prefer a user-defined class method when the receiver is a user
        // class symbol that has one with this name. (BCL lookup is the
        // fallback for imported CLR types.)
        if (receiver.Type is StructSymbol userClassPriority && userClassPriority.TryGetMethodIncludingInherited(methodName, out var userMethodPriority))
        {
            return BindUserInstanceCall(receiver, userMethodPriority, arguments, ce);
        }

        var clrType = receiver.Type.ClrType;
        var candidates = clrType.GetMethods(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
            .Where(m => m.Name == methodName)
            .ToList();
        if (candidates.Count > 0)
        {
            var argTypes = new System.Type[arguments.Length];
            var argsAllTyped = true;
            for (var i = 0; i < arguments.Length; i++)
            {
                var t = arguments[i].Type?.ClrType;
                if (t == null)
                {
                    argsAllTyped = false;
                    break;
                }

                argTypes[i] = t;
            }

            if (argsAllTyped)
            {
                var resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences);
                switch (resolution.Outcome)
                {
                    case OverloadResolution.ResolutionOutcome.Resolved:
                        var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols) ?? TypeSymbol.FromClrType(resolution.Best.ReturnType);
                        var instParameters = resolution.Best.GetParameters();
                        var instArguments = AppendOmittedOptionalArguments(arguments, instParameters);
                        var instRefKinds = ComputeArgumentRefKinds(instParameters);
                        ValidateRefArguments(instArguments, instRefKinds, methodName, ce.Location);
                        return new BoundImportedInstanceCallExpression(null, receiver, resolution.Best, returnType, instArguments, instRefKinds, typeArgSymbols);
                    case OverloadResolution.ResolutionOutcome.Ambiguous:
                        Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length);
                        return new BoundErrorExpression(null);
                    default:
                        break;
                }
            }
        }

        // Phase 3.B.6 / ADR-0019: extension function fallback. After all
        // instance/static lookups fail, try matching by (receiverType, name).
        if (receiver != null && scope.TryLookupExtensionFunction(receiver.Type, methodName, out var extFn))
        {
            return BindExtensionFunctionCall(receiver, extFn, arguments, ce);
        }

        // Issue #294: BCL/library [Extension] method dispatched with instance
        // (receiver) syntax. After instance members and user extension
        // functions fail, fall back to imported static [Extension] methods
        // whose first parameter is compatible with the receiver type.
        if (receiver != null && TryBindImportedExtensionCall(receiver, methodName, arguments, ce, out var importedExt, explicitTypeArgs, typeArgSymbols))
        {
            return importedExt;
        }

        Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        return new BoundErrorExpression(null);
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
        ImmutableArray<TypeSymbol> typeArgSymbols = default)
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
            var t = arguments[i].Type?.ClrType;
            if (t == null)
            {
                return false;
            }

            argTypes[i] = t;
        }

        var resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences);
        switch (resolution.Outcome)
        {
            case OverloadResolution.ResolutionOutcome.Resolved:
                var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols) ?? TypeSymbol.FromClrType(resolution.Best.ReturnType);
                var inheritedParameters = resolution.Best.GetParameters();
                var inheritedArguments = AppendOmittedOptionalArguments(arguments, inheritedParameters);
                var refKinds = ComputeArgumentRefKinds(inheritedParameters);
                ValidateRefArguments(inheritedArguments, refKinds, methodName, ce.Location);
                result = new BoundImportedInstanceCallExpression(null, receiver, resolution.Best, returnType, inheritedArguments, refKinds, typeArgSymbols);
                return true;
            case OverloadResolution.ResolutionOutcome.Ambiguous:
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length);
                result = new BoundErrorExpression(null);
                return true;
            default:
                return false;
        }
    }

    private BoundExpression BindExtensionFunctionCall(BoundExpression receiver, FunctionSymbol extension, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce)
    {
        // The extension's first parameter is the receiver; user arguments line
        // up against parameters[1..].
        var userParamCount = extension.Parameters.Length - 1;
        if (arguments.Length != userParamCount)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, extension.Name, userParamCount, arguments.Length);
            return new BoundErrorExpression(null);
        }

        // Issue #326: a generic extension function
        // `func (r R) Name[T](item T) T` resolves its type parameters either
        // from an explicit `[T1, T2]` type-argument list at the call site or by
        // left-to-right inference from the receiver and argument types matched
        // against the declared parameter types. Mirrors the free-function
        // generic path (Phase 4.1 / ADR-0020).
        Dictionary<TypeParameterSymbol, TypeSymbol> substitution = null;
        if (extension.IsGeneric)
        {
            substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            if (ce.TypeArgumentList != null)
            {
                var explicitArgs = ce.TypeArgumentList.Arguments;
                if (explicitArgs.Count != extension.TypeParameters.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(ce.TypeArgumentList.Location, extension.Name, extension.TypeParameters.Length, explicitArgs.Count);
                    return new BoundErrorExpression(null);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = BindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    substitution[extension.TypeParameters[i]] = ta;
                }
            }
            else
            {
                // The receiver lines up against parameters[0]; user arguments
                // against parameters[1..]. Inferring from the receiver too lets
                // a generic receiver type (e.g. `func (s []T) ...`) bind T.
                if (receiver?.Type != null)
                {
                    InferTypeArguments(extension.Parameters[0].Type, receiver.Type, substitution);
                }

                for (var i = 0; i < arguments.Length; i++)
                {
                    if (arguments[i].Type != null)
                    {
                        InferTypeArguments(extension.Parameters[i + 1].Type, arguments[i].Type, substitution);
                    }
                }

                foreach (var tp in extension.TypeParameters)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, extension.Name, tp.Name);
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            var constraintLocation = ce.TypeArgumentList != null
                ? ce.TypeArgumentList.Location
                : ce.Identifier.Location;
            foreach (var tp in extension.TypeParameters)
            {
                var typeArg = substitution[tp];
                if (!SatisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, DescribeConstraint(tp));
                    return new BoundErrorExpression(null);
                }
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(extension.Parameters.Length);
        var receiverParamType = substitution != null ? SubstituteType(extension.Parameters[0].Type, substitution) : extension.Parameters[0].Type;
        convertedArgs.Add(BindConversion(ce.Location, receiver, receiverParamType));
        for (var i = 0; i < arguments.Length; i++)
        {
            var paramType = extension.Parameters[i + 1].Type;
            if (substitution != null && TypeSymbol.ContainsTypeParameter(paramType))
            {
                // A parameter typed as an open T is encoded as System.Object in
                // the emitted signature; pass the argument unconverted so the
                // emitter inserts box / unbox.any around the erased boundary.
                convertedArgs.Add(arguments[i]);
            }
            else
            {
                var expectedType = substitution != null ? SubstituteType(paramType, substitution) : paramType;
                convertedArgs.Add(BindConversion(ce.Arguments[i].Location, arguments[i], expectedType));
            }
        }

        if (substitution != null)
        {
            var returnType = SubstituteType(extension.Type, substitution);
            return new BoundCallExpression(null, extension, convertedArgs.MoveToImmutable(), returnType);
        }

        return new BoundCallExpression(null, extension, convertedArgs.MoveToImmutable());
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
    /// <returns>True when an imported extension method was matched (success or ambiguity); false to let the caller report GS0159.</returns>
    private bool TryBindImportedExtensionCall(BoundExpression receiver, string methodName, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, out BoundExpression result, System.Type[] explicitTypeArgs = null, ImmutableArray<TypeSymbol> typeArgSymbols = default)
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
            var t = arguments[i].Type?.ClrType;
            if (t == null)
            {
                return false;
            }

            argTypes[i + 1] = t;
        }

        var candidates = CollectImportedExtensionMethods(methodName);
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
        var resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences);
        switch (resolution.Outcome)
        {
            case OverloadResolution.ResolutionOutcome.Resolved:
                break;
            case OverloadResolution.ResolutionOutcome.Ambiguous:
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length);
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

        // Issue #327: fill in any trailing optional parameters the call omitted
        // (e.g. the CancellationToken on HttpResponse.WriteAsync(text)).
        var parameters = best.GetParameters();
        bound = AppendOmittedOptionalArguments(bound, parameters);

        var refKinds = ComputeArgumentRefKinds(parameters);
        ValidateRefArguments(bound, refKinds, methodName, ce.Location);
        result = new BoundImportedCallExpression(null, function, bound, refKinds, typeArgSymbols);
        return true;
    }

    /// <summary>
    /// Issue #294: collects imported CLR static <c>[Extension]</c> methods with
    /// the given name whose declaring static class lives in an imported
    /// namespace. Candidates may be open generic method definitions; generic
    /// inference happens later in overload resolution.
    /// </summary>
    /// <param name="methodName">The method name at the call site.</param>
    /// <returns>The matching candidate methods (possibly empty).</returns>
    private List<MethodInfo> CollectImportedExtensionMethods(string methodName)
    {
        var result = new List<MethodInfo>();
        foreach (var type in GetImportedExtensionClasses())
        {
            MethodInfo[] methods;
            try
            {
                methods = type.GetMethods(BindingFlags.Public | BindingFlags.Static);
            }
            catch
            {
                continue;
            }

            foreach (var method in methods)
            {
                if (!string.Equals(method.Name, methodName, StringComparison.Ordinal))
                {
                    continue;
                }

                if (!HasExtensionAttribute(method))
                {
                    continue;
                }

                if (method.GetParameters().Length == 0)
                {
                    continue;
                }

                result.Add(method);
            }
        }

        return result;
    }

    /// <summary>
    /// Issue #294: enumerates static classes declared in the currently imported
    /// namespaces that carry <c>[Extension]</c> (i.e. host extension methods).
    /// The result is cached per binder; the import count acts as a cheap
    /// invalidation key because imports only grow during binding.
    /// </summary>
    /// <returns>The imported static extension-holding classes.</returns>
    private List<Type> GetImportedExtensionClasses()
    {
        var imports = scope.GetDeclaredImports();
        var importCount = imports.IsDefault ? 0 : imports.Length;
        if (cachedImportedExtensionClasses != null && cachedImportedExtensionImportCount == importCount)
        {
            return cachedImportedExtensionClasses;
        }

        var namespaces = new HashSet<string>(StringComparer.Ordinal);
        if (!imports.IsDefault)
        {
            foreach (var import in imports)
            {
                if (!string.IsNullOrEmpty(import.Target))
                {
                    namespaces.Add(import.Target);
                }
            }
        }

        var classes = new List<Type>();
        if (namespaces.Count > 0)
        {
            foreach (var assembly in scope.References.Assemblies)
            {
                IEnumerable<Type> types;
                try
                {
                    types = assembly.GetTypes();
                }
                catch (ReflectionTypeLoadException ex)
                {
                    types = ex.Types.Where(t => t != null);
                }
                catch
                {
                    continue;
                }

                foreach (var type in types)
                {
                    if (type == null || type.Namespace == null || !namespaces.Contains(type.Namespace))
                    {
                        continue;
                    }

                    if (!IsStaticClass(type) || !HasExtensionAttribute(type))
                    {
                        continue;
                    }

                    classes.Add(type);
                }
            }
        }

        cachedImportedExtensionClasses = classes;
        cachedImportedExtensionImportCount = importCount;
        return classes;
    }

    /// <summary>
    /// A C# static class is a sealed abstract class. Detected structurally so
    /// it works under <see cref="System.Reflection.MetadataLoadContext"/>.
    /// </summary>
    /// <param name="type">The candidate type.</param>
    /// <returns>Whether the type is a static class.</returns>
    private static bool IsStaticClass(Type type)
        => type.IsClass && type.IsAbstract && type.IsSealed;

    /// <summary>
    /// Robustly detects <c>[System.Runtime.CompilerServices.ExtensionAttribute]</c>
    /// via <see cref="CustomAttributeData"/> (never runtime
    /// <c>GetCustomAttribute</c>, which throws under
    /// <see cref="System.Reflection.MetadataLoadContext"/>).
    /// </summary>
    /// <param name="member">The type or method to inspect.</param>
    /// <returns>Whether the member carries the extension attribute.</returns>
    private static bool HasExtensionAttribute(MemberInfo member)
    {
        try
        {
            foreach (var attribute in member.GetCustomAttributesData())
            {
                if (string.Equals(
                    attribute.AttributeType?.FullName,
                    "System.Runtime.CompilerServices.ExtensionAttribute",
                    StringComparison.Ordinal))
                {
                    return true;
                }
            }
        }
        catch
        {
            // MetadataLoadContext may throw resolving the attribute type; treat
            // as "not an extension" rather than failing the whole binding.
        }

        return false;
    }

    private BoundExpression BindUserInstanceCall(BoundExpression receiver, FunctionSymbol method, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce)
    {
        var parameterOffset = method.ExplicitReceiverParameter == null ? 0 : 1;
        var callableParameterCount = method.Parameters.Length - parameterOffset;
        if (arguments.Length != callableParameterCount)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, callableParameterCount, arguments.Length);
            return new BoundErrorExpression(null);
        }

        // Phase 4.3b / ADR-0020: if the receiver is a constructed generic
        // class/struct, substitute the method's parameter types and return
        // type with the receiver's type-argument map. The method symbol
        // itself (and its bound body) are kept intact so runtime dispatch
        // through program.Functions[method] continues to work.
        Dictionary<TypeParameterSymbol, TypeSymbol> substitution = TryBuildReceiverSubstitution(receiver.Type);

        // Issue #312 / ADR-0020: the method may declare its own generic
        // type-parameter list (`func M[T](...) T`). Resolve those type
        // arguments from an explicit `[T1, T2]` list at the call site or by
        // left-to-right inference from argument types, then fold them into the
        // same substitution map used for the receiver's type arguments.
        if (method.IsGeneric)
        {
            if (substitution == null)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            }

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
                    InferTypeArguments(method.Parameters[i + parameterOffset].Type, arguments[i].Type, substitution);
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

            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
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
            var paramType = method.Parameters[i + parameterOffset].Type;

            // An argument bound to an open type parameter is left untouched —
            // the emitter boxes value types at the call boundary (the parameter
            // is encoded as System.Object under the type-erased model).
            if (paramType is TypeParameterSymbol)
            {
                convertedArgs.Add(arguments[i]);
                continue;
            }

            var expectedType = substitution != null ? SubstituteType(paramType, substitution) : paramType;
            convertedArgs.Add(BindConversion(ce.Arguments[i].Location, arguments[i], expectedType));
        }

        if (substitution != null)
        {
            var substitutedReturn = SubstituteType(method.Type, substitution);
            if (!ReferenceEquals(substitutedReturn, method.Type))
            {
                return new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable(), substitutedReturn);
            }
        }

        return new BoundUserInstanceCallExpression(null, receiver, method, convertedArgs.ToImmutable());
    }

    private static Dictionary<TypeParameterSymbol, TypeSymbol> TryBuildReceiverSubstitution(TypeSymbol receiverType)
    {
        if (receiverType is StructSymbol s
            && !s.TypeArguments.IsDefaultOrEmpty
            && s.Definition != null
            && !ReferenceEquals(s.Definition, s))
        {
            var defTps = s.Definition.TypeParameters;
            if (!defTps.IsDefaultOrEmpty && defTps.Length == s.TypeArguments.Length)
            {
                var map = new Dictionary<TypeParameterSymbol, TypeSymbol>(defTps.Length);
                for (var i = 0; i < defTps.Length; i++)
                {
                    map[defTps[i]] = s.TypeArguments[i];
                }

                return map;
            }
        }

        return null;
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
            elements.Add(BindConversion(elementSyntax, elementType));
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
            var key = BindConversion(entrySyntax.Key, mts.KeyType);
            var value = BindConversion(entrySyntax.Value, mts.ValueType);
            entries.Add(new BoundMapEntry(key, value));
        }

        return new BoundMapLiteralExpression(null, mts, entries.ToImmutable());
    }

    private BoundExpression BindIndexExpression(IndexExpressionSyntax syntax)
    {
        var target = BindExpression(syntax.Target);

        // Phase 3.A.4: map indexing `m[k]` — key bound to K, result type V.
        // The Go convention "zero value if missing" applies at evaluation;
        // the bound representation reuses BoundIndexExpression with the
        // element type set to V.
        if (target.Type is MapTypeSymbol mapType)
        {
            var key = BindConversion(syntax.Index, mapType.KeyType);
            return new BoundIndexExpression(null, target, key, mapType.ValueType);
        }

        var element = GetIndexElementType(target.Type);
        if (element != null)
        {
            var index = BindConversion(syntax.Index, TypeSymbol.Int32);
            return new BoundIndexExpression(null, target, index, element);
        }

        // Phase 4 exit: CLR indexer read on an imported reference type
        // (e.g. `d["k"]` on Dictionary[string, int]). Pick a public
        // instance indexer (a `PropertyInfo` whose `GetIndexParameters()`
        // matches the single argument by assignability).
        // Issue #209: when the target carries inner-position nullable flags,
        // use them to type the element correctly (e.g., `list[0]` on `List<string?>` → `string?`).
        if (target.Type is NullabilityAnnotatedTypeSymbol annotIdx && annotIdx.ClrType is System.Type clrAnnotIdx && TryResolveClrIndexer(clrAnnotIdx, new[] { syntax.Index }, out var idxPropAnnot, out var idxArgsAnnot))
        {
            var elemTypeAnnot = annotIdx.GetTypeArgumentSymbolForClrType(idxPropAnnot.PropertyType);
            return new BoundClrIndexExpression(null, target, idxPropAnnot, idxArgsAnnot, elemTypeAnnot);
        }

        if (target.Type is ImportedTypeSymbol && target.Type.ClrType is System.Type clrTarget && TryResolveClrIndexer(clrTarget, new[] { syntax.Index }, out var idxProp, out var idxArgs))
        {
            var elementType = MapErasedIndexerElementType((ImportedTypeSymbol)target.Type, idxProp);
            return new BoundClrIndexExpression(null, target, idxProp, idxArgs, elementType);
        }

        if (target.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(syntax.Target.Location, target.Type);
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

        var element = GetIndexElementType(variable.Type);
        if (element != null)
        {
            var index = BindConversion(syntax.Index, TypeSymbol.Int32);
            var value = BindConversion(syntax.Value, element);
            return new BoundIndexAssignmentExpression(null, variable, index, value, element);
        }

        // Phase 3.A.4: map indexed assignment `m[k] = v` — key bound to K,
        // value bound to V.
        if (variable.Type is MapTypeSymbol mapType)
        {
            var keyExpr = BindConversion(syntax.Index, mapType.KeyType);
            var valExpr = BindConversion(syntax.Value, mapType.ValueType);
            return new BoundIndexAssignmentExpression(null, variable, keyExpr, valExpr, mapType.ValueType);
        }

        // Phase 4 exit: CLR indexer write on an imported reference type
        // (e.g. `d["k"] = 1` on Dictionary[string, int]).
        // Issue #209: honour inner-position nullable flags when present.
        if (variable.Type is NullabilityAnnotatedTypeSymbol annotWr && variable.Type.ClrType is System.Type clrAnnotWr && TryResolveClrIndexer(clrAnnotWr, new[] { syntax.Index }, out var idxPropAnnotWr, out var idxArgsAnnotWr))
        {
            if (!idxPropAnnotWr.CanWrite)
            {
                Diagnostics.ReportTypeNotIndexable(syntax.TargetIdentifier.Location, variable.Type);
                return new BoundErrorExpression(null);
            }

            var valueTypeAnnotWr = annotWr.GetTypeArgumentSymbolForClrType(idxPropAnnotWr.PropertyType);
            var boundValueAnnotWr = BindConversion(syntax.Value, valueTypeAnnotWr);
            return new BoundClrIndexAssignmentExpression(null, variable, idxPropAnnotWr, idxArgsAnnotWr, boundValueAnnotWr, valueTypeAnnotWr);
        }

        if (variable.Type is ImportedTypeSymbol && variable.Type.ClrType is System.Type clrTarget && TryResolveClrIndexer(clrTarget, new[] { syntax.Index }, out var idxProp, out var idxArgs))
        {
            if (!idxProp.CanWrite)
            {
                Diagnostics.ReportTypeNotIndexable(syntax.TargetIdentifier.Location, variable.Type);
                return new BoundErrorExpression(null);
            }

            var valueType = TypeSymbol.FromClrType(idxProp.PropertyType);
            var boundValue = BindConversion(syntax.Value, valueType);
            return new BoundClrIndexAssignmentExpression(null, variable, idxProp, idxArgs, boundValue, valueType);
        }

        if (variable.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(syntax.TargetIdentifier.Location, variable.Type);
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
                var openIndexer = openDefinition.GetProperty(
                    closedIndexer.Name,
                    BindingFlags.Public | BindingFlags.Instance);
                if (openIndexer?.PropertyType is System.Type openElement && openElement.IsGenericParameter)
                {
                    var position = openElement.GenericParameterPosition;
                    if (position >= 0 && position < target.TypeArguments.Length)
                    {
                        return target.TypeArguments[position];
                    }
                }
            }
            catch (System.Reflection.AmbiguousMatchException)
            {
                // Fall back to the erased element type below.
            }
        }

        return TypeSymbol.FromClrType(closedIndexer.PropertyType);
    }

    private bool TryResolveClrIndexer(System.Type clrTarget, IReadOnlyList<ExpressionSyntax> argSyntaxes, out PropertyInfo indexer, out ImmutableArray<BoundExpression> boundArguments)
    {
        indexer = null;
        boundArguments = ImmutableArray<BoundExpression>.Empty;

        var bound = ImmutableArray.CreateBuilder<BoundExpression>(argSyntaxes.Count);
        for (var i = 0; i < argSyntaxes.Count; i++)
        {
            bound.Add(BindExpression(argSyntaxes[i]));
        }

        foreach (var prop in clrTarget.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var ps = prop.GetIndexParameters();
            if (ps.Length != bound.Count)
            {
                continue;
            }

            var ok = true;
            for (var i = 0; i < ps.Length; i++)
            {
                var argClr = bound[i].Type?.ClrType;
                if (argClr == null || !ClrTypeUtilities.IsAssignableByName(ps[i].ParameterType, argClr))
                {
                    ok = false;
                    break;
                }
            }

            if (ok)
            {
                indexer = prop;
                boundArguments = bound.ToImmutable();
                return true;
            }
        }

        return false;
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

    private BoundExpression BindConversion(ExpressionSyntax syntax, TypeSymbol type, bool allowExplicit = false)
    {
        var expression = BindExpression(syntax);
        return BindConversion(syntax.Location, expression, type, allowExplicit);
    }

    private BoundExpression BindConversion(TextLocation diagnosticLocation, BoundExpression expression, TypeSymbol type, bool allowExplicit = false)
    {
        // Issue #337: a CLR member method group has no fixed type until the
        // target delegate signature drives overload selection. Resolve it here,
        // where the expected type is known, before classifying conversions.
        if (expression is BoundClrMethodGroupExpression { ResolvedMethod: null } clrMethodGroup)
        {
            return BindClrMethodGroupConversion(diagnosticLocation, clrMethodGroup, type);
        }

        var conversion = Conversion.Classify(expression.Type, type);

        if (!conversion.Exists)
        {
            // Stream E: fall back to a user-defined op_Implicit (and
            // op_Explicit when allowed) on either source or target CLR type.
            if (expression.Type?.ClrType != null && type?.ClrType != null
                && ClrOperatorResolution.TryResolveConversion(expression.Type.ClrType, type.ClrType, allowExplicit, out var convMethod, out var isExplicit))
            {
                _ = isExplicit;
                return new BoundClrConversionCallExpression(null, expression, convMethod, type);
            }

            if (expression.Type != TypeSymbol.Error && type != TypeSymbol.Error)
            {
                Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, type);
            }

            return new BoundErrorExpression(null);
        }

        if (!allowExplicit && conversion.IsExplicit)
        {
            Diagnostics.ReportCannotConvertImplicitly(diagnosticLocation, expression.Type, type);
        }

        if (conversion.IsIdentity)
        {
            return expression;
        }

        return new BoundConversionExpression(null, type, expression);
    }

    private VariableSymbol BindVariableDeclaration(SyntaxToken identifier, bool isReadOnly, TypeSymbol type)
    {
        return BindVariableDeclaration(identifier, isReadOnly, type, Accessibility.Public);
    }

    private VariableSymbol BindVariableDeclaration(SyntaxToken identifier, bool isReadOnly, TypeSymbol type, Accessibility accessibility)
    {
        var name = identifier.Text ?? "?";
        var declare = !identifier.IsMissing;
        var variable = function == null
                            ? (VariableSymbol)new GlobalVariableSymbol(name, isReadOnly, type, accessibility, declaringSyntax: identifier)
                            : new LocalVariableSymbol(name, isReadOnly, type, declaringSyntax: identifier);

        if (declare && !scope.TryDeclareVariable(variable))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, name);
        }

        return variable;
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

        if (scope.TryLookupSymbol(name) is not FunctionSymbol function)
        {
            return false;
        }

        if (function.IsInstanceMethod
            || function.IsGeneric
            || function.IsExtension
            || function.IsStatic
            || function.StaticOwnerType != null
            || function.Package == null)
        {
            return false;
        }

        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(function.Parameters.Length);
        foreach (var parameter in function.Parameters)
        {
            if (parameter.IsVariadic)
            {
                return false;
            }

            parameterTypes.Add(parameter.Type);
        }

        var fnType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), function.Type ?? TypeSymbol.Void);
        methodGroup = new BoundMethodGroupExpression(null, function, fnType);
        return true;
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
        foreach (var method in declaringType.GetMethods(flags))
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

    // Issue #337: resolve an unresolved CLR method group against an expected
    // target type. The target must be a CLR delegate type; the group's overloads
    // are filtered by signature compatibility with the delegate's Invoke method
    // (arity + return-type compatibility), then C#-style overload resolution
    // picks the single best candidate using the delegate's parameter types as
    // the "argument" types. On success the resolved method-group node carries the
    // selected MethodInfo and target delegate type; on failure a GS0218 is
    // reported.
    private BoundExpression BindClrMethodGroupConversion(TextLocation diagnosticLocation, BoundClrMethodGroupExpression group, TypeSymbol targetType)
    {
        var delegateClr = targetType?.ClrType;
        if (delegateClr == null || !ClrTypeUtilities.IsDelegateType(delegateClr))
        {
            // A non-delegate target (e.g. `var x int32 = Console.WriteLine`) or
            // an already-errored target: report unless the target itself is an
            // error type (which already produced a diagnostic).
            if (targetType != null && targetType != TypeSymbol.Error)
            {
                Diagnostics.ReportCannotConvertMethodGroup(diagnosticLocation, group.MethodName, targetType);
            }

            return new BoundErrorExpression(null);
        }

        var invoke = delegateClr.GetMethod("Invoke");
        if (invoke == null)
        {
            Diagnostics.ReportCannotConvertMethodGroup(diagnosticLocation, group.MethodName, targetType);
            return new BoundErrorExpression(null);
        }

        var invokeParams = invoke.GetParameters();
        var argTypes = new Type[invokeParams.Length];
        for (var i = 0; i < invokeParams.Length; i++)
        {
            argTypes[i] = invokeParams[i].ParameterType;
        }

        var applicable = new List<MethodInfo>();
        foreach (var candidate in group.Candidates)
        {
            if (candidate.GetParameters().Length != invokeParams.Length)
            {
                continue;
            }

            if (!IsMethodGroupReturnCompatible(candidate.ReturnType, invoke.ReturnType))
            {
                continue;
            }

            applicable.Add(candidate);
        }

        if (applicable.Count > 0)
        {
            var resolution = OverloadResolution.Resolve(applicable, argTypes);
            if (resolution.Outcome == OverloadResolution.ResolutionOutcome.Resolved)
            {
                return new BoundClrMethodGroupExpression(group.Syntax, group.Receiver, resolution.Best, targetType);
            }
        }

        Diagnostics.ReportCannotConvertMethodGroup(diagnosticLocation, group.MethodName, targetType);
        return new BoundErrorExpression(null);
    }

    // Issue #337: a method-group overload's return type is compatible with a
    // delegate's Invoke return type when both are void, or when the method's
    // (non-void) return is identity / implicitly reference- or value-convertible
    // (by name, MetadataLoadContext-safe) to the delegate's (non-void) return.
    private static bool IsMethodGroupReturnCompatible(Type methodReturn, Type invokeReturn)
    {
        var invokeVoid = invokeReturn == null
            || string.Equals(invokeReturn.FullName, "System.Void", StringComparison.Ordinal);
        var methodVoid = methodReturn == null
            || string.Equals(methodReturn.FullName, "System.Void", StringComparison.Ordinal);

        if (invokeVoid || methodVoid)
        {
            return invokeVoid && methodVoid;
        }

        return ClrTypeUtilities.IsAssignableByName(invokeReturn, methodReturn);
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
        if (currentTypeParameters != null && currentTypeParameters.TryGetValue(name, out var tp))
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

        if (candidate == null || !candidate.IsClass || candidate.IsInterface || candidate.IsSealed)
        {
            return false;
        }

        importedBaseType = TypeSymbol.FromClrType(candidate);
        return importedBaseType?.ClrType != null;
    }

    /// <summary>
    /// Issue #306: binds the explicit base-constructor argument list
    /// (<c>: Base(args)</c>) of a class declaration and resolves it against the
    /// base class's constructors. The arguments are bound in a scope that
    /// exposes the primary-constructor parameters so they can be forwarded to
    /// the base. On success the resolved <see cref="BaseConstructorInitializer"/>
    /// is recorded on <paramref name="structSymbol"/> for the emitter; failures
    /// surface a diagnostic.
    /// </summary>
    private void BindBaseConstructorInitializer(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType,
        ImmutableArray<ParameterSymbol> primaryCtorParameters)
    {
        if (!syntax.HasBaseConstructorArguments)
        {
            return;
        }

        var location = syntax.BaseConstructorOpenParenthesisToken.Location;

        if (baseClassSymbol == null && importedBaseType == null)
        {
            Diagnostics.ReportBaseConstructorArgumentsWithoutBase(location);
            return;
        }

        // Bind the argument expressions with the primary-constructor parameters
        // in scope (they are the typical source of forwarded values).
        var savedScope = scope;
        scope = new BoundScope(savedScope);
        if (!primaryCtorParameters.IsDefaultOrEmpty)
        {
            foreach (var p in primaryCtorParameters)
            {
                scope.TryDeclareVariable(p);
            }
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.BaseConstructorArguments.Count);
        for (var i = 0; i < syntax.BaseConstructorArguments.Count; i++)
        {
            boundArguments.Add(BindExpression(syntax.BaseConstructorArguments[i]));
        }

        scope = savedScope;

        if (importedBaseType?.ClrType is System.Type clrBase)
        {
            var clrInit = ResolveClrBaseConstructor(i => syntax.BaseConstructorArguments[i].Location, clrBase, boundArguments, location);
            if (clrInit != null)
            {
                structSymbol.SetBaseConstructorInitializer(clrInit);
            }

            return;
        }

        var gsharpInit = ResolveGSharpBaseConstructor(i => syntax.BaseConstructorArguments[i].Location, structSymbol.Name, baseClassSymbol, boundArguments, location);
        if (gsharpInit != null)
        {
            structSymbol.SetBaseConstructorInitializer(gsharpInit);
        }
    }

    /// <summary>Resolves a base-constructor initializer against an imported CLR base type's constructors (issue #306). Returns <c>null</c> (after reporting a diagnostic) when no accessible constructor matches.</summary>
    private BaseConstructorInitializer ResolveClrBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        System.Type clrBase,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        TextLocation location)
    {
        var ctors = clrBase.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .Where(c => c.IsPublic || c.IsFamily || c.IsFamilyOrAssembly)
            .ToArray();

        var argTypes = new System.Type[boundArguments.Count];
        var argsAllTyped = true;
        for (var i = 0; i < boundArguments.Count; i++)
        {
            var t = boundArguments[i].Type?.ClrType;
            if (t == null)
            {
                argsAllTyped = false;
                break;
            }

            argTypes[i] = t;
        }

        ConstructorInfo bestCtor = null;
        if (argsAllTyped)
        {
            var resolution = OverloadResolution.Resolve(ctors, argTypes);
            switch (resolution.Outcome)
            {
                case OverloadResolution.ResolutionOutcome.Resolved:
                    bestCtor = resolution.Best as ConstructorInfo;
                    break;
                case OverloadResolution.ResolutionOutcome.Ambiguous:
                    Diagnostics.ReportAmbiguousOverload(location, clrBase.Name, resolution.Ambiguous.Length);
                    return null;
                default:
                    break;
            }
        }

        if (bestCtor == null)
        {
            Diagnostics.ReportNoMatchingBaseConstructor(location, clrBase.Name, boundArguments.Count);
            return null;
        }

        // Issue #306 (item 2): honor `ref`/`out`/`in` base-constructor parameters.
        // For a by-ref parameter the bound argument must already be an address-of
        // expression (`&x`); the emitter forwards the address rather than a value.
        var ctorParams = bestCtor.GetParameters();
        var refKindsBuilder = ImmutableArray.CreateBuilder<RefKind>(boundArguments.Count);
        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(boundArguments.Count);
        for (var i = 0; i < boundArguments.Count; i++)
        {
            var clrParamType = ctorParams[i].ParameterType;
            if (clrParamType.IsByRef)
            {
                var refKind = ctorParams[i].IsOut ? RefKind.Out
                    : ctorParams[i].IsIn ? RefKind.In
                    : RefKind.Ref;
                refKindsBuilder.Add(refKind);

                // A by-ref argument is forwarded as-is (it is already a managed
                // pointer, e.g. the result of `&x`); no value conversion applies.
                convertedArgs.Add(boundArguments[i]);
                continue;
            }

            refKindsBuilder.Add(RefKind.None);
            var targetType = TypeSymbol.FromClrType(clrParamType);
            convertedArgs.Add(BindConversion(argLocation(i), boundArguments[i], targetType));
        }

        return new BaseConstructorInitializer(convertedArgs.ToImmutable(), bestCtor, refKindsBuilder.ToImmutable());
    }

    /// <summary>Resolves a base-constructor initializer against a GSharp base class's primary constructor (issue #306). Returns <c>null</c> (after reporting a diagnostic) when no match.</summary>
    private BaseConstructorInitializer ResolveGSharpBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        string derivedNameForDiag,
        StructSymbol baseClassSymbol,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        TextLocation location)
    {
        if (baseClassSymbol == null)
        {
            Diagnostics.ReportNoMatchingBaseConstructor(location, derivedNameForDiag, boundArguments.Count);
            return null;
        }

        var baseParams = baseClassSymbol.PrimaryConstructorParameters;
        if (boundArguments.Count != baseParams.Length)
        {
            Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count);
            return null;
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(boundArguments.Count);
        for (var i = 0; i < boundArguments.Count; i++)
        {
            var argument = boundArguments[i];
            var parameter = baseParams[i];
            if (argument.Type != parameter.Type
                && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit)
            {
                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count);
                }

                return null;
            }

            convertedArgs.Add(BindConversion(argLocation(i), argument, parameter.Type));
        }

        return new BaseConstructorInitializer(convertedArgs.ToImmutable(), baseClassSymbol);
    }

    /// <summary>
    /// Issue #306: binds the standalone user-defined constructors (<c>init(...)</c>)
    /// declared in a class body. Each constructor becomes a <see cref="ConstructorSymbol"/>
    /// whose body is bound in <see cref="BindProgram"/> as an instance-method body and
    /// emitted/interpreted as a <c>.ctor</c>.
    /// </summary>
    private void BindConstructorDeclarations(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        PackageSymbol package,
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType)
    {
        if (syntax.Constructors.IsDefaultOrEmpty)
        {
            return;
        }

        if (!structSymbol.IsClass)
        {
            return;
        }

        // A class uses EITHER the Kotlin-style primary constructor sugar OR
        // explicit `init(...)` constructors — mixing the two is ambiguous.
        if (structSymbol.HasPrimaryConstructor)
        {
            Diagnostics.ReportPrimaryAndExplicitConstructors(syntax.Constructors[0].InitKeyword.Location, structSymbol.Name);
            return;
        }

        // Only a single explicit constructor is supported today; additional
        // declarations are diagnosed rather than silently dropped.
        for (var c = 1; c < syntax.Constructors.Length; c++)
        {
            Diagnostics.ReportMultipleConstructorsUnsupported(syntax.Constructors[c].InitKeyword.Location, structSymbol.Name);
        }

        var ctorSyntax = syntax.Constructors[0];

        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        var seenParameterNames = new HashSet<string>();
        foreach (var parameterSyntax in ctorSyntax.Parameters)
        {
            var parameterName = parameterSyntax.Identifier.Text;
            var parameterType = BindTypeClause(parameterSyntax.Type);
            if (parameterSyntax.IsVariadic)
            {
                Diagnostics.ReportVariadicParameterNotSupportedHere(parameterSyntax.Location, parameterName);
            }

            if (!seenParameterNames.Add(parameterName))
            {
                Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
            }
            else
            {
                parameters.Add(new ParameterSymbol(parameterName, parameterType, declaringSyntax: parameterSyntax.Identifier));
            }
        }

        var ctorAccessibility = ResolveAccessibility(ctorSyntax.AccessibilityModifier);
        var ctorFunction = new FunctionSymbol(
            ".ctor",
            parameters.ToImmutable(),
            TypeSymbol.Void,
            declaration: null,
            package,
            ctorAccessibility,
            receiverType: structSymbol)
        {
            IsSpecialName = true,
        };

        var constructorSymbol = new ConstructorSymbol(ctorFunction, ctorSyntax);

        // Resolve the optional `: base(args)` initializer, with the constructor
        // parameters in scope so they can be forwarded to the base.
        if (ctorSyntax.HasBaseInitializer)
        {
            var location = ctorSyntax.BaseKeyword.Location;

            var savedScope = scope;
            scope = new BoundScope(savedScope);
            foreach (var p in ctorFunction.Parameters)
            {
                scope.TryDeclareVariable(p);
            }

            var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(ctorSyntax.BaseArguments.Count);
            for (var i = 0; i < ctorSyntax.BaseArguments.Count; i++)
            {
                boundArguments.Add(BindExpression(ctorSyntax.BaseArguments[i]));
            }

            scope = savedScope;

            if (baseClassSymbol == null && importedBaseType == null)
            {
                Diagnostics.ReportBaseConstructorArgumentsWithoutBase(location);
            }
            else if (importedBaseType?.ClrType is System.Type clrBase)
            {
                var init = ResolveClrBaseConstructor(i => ctorSyntax.BaseArguments[i].Location, clrBase, boundArguments, location);
                if (init != null)
                {
                    constructorSymbol.SetBaseInitializer(init);
                }
            }
            else
            {
                var init = ResolveGSharpBaseConstructor(i => ctorSyntax.BaseArguments[i].Location, structSymbol.Name, baseClassSymbol, boundArguments, location);
                if (init != null)
                {
                    constructorSymbol.SetBaseInitializer(init);
                }
            }
        }

        structSymbol.SetExplicitConstructor(constructorSymbol);
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
    /// Phase 4 of #141 / ADR-0047 §5: returns true if any annotation in the
    /// list is the bare <c>@Attribute</c> sugar marker (single-segment name
    /// <c>Attribute</c>, no use-site target qualifier).
    /// </summary>
    /// <param name="annotations">Annotations from the declaration's syntax node.</param>
    /// <returns>True if the marker is present.</returns>
    private static bool HasAttributeSugarMarker(ImmutableArray<AnnotationSyntax> annotations)
    {
        if (annotations.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var annotation in annotations)
        {
            // ADR-0047 §5: the sugar marker is exactly `@Attribute` (no
            // use-site target qualifier; no arguments; single-segment name).
            if (annotation.Target != null)
            {
                continue;
            }

            if (annotation.NameSegments.Length != 1)
            {
                continue;
            }

            if (annotation.NameSegments[0].Text == "Attribute")
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Phase 4 of #141 / ADR-0047 §5: returns true if <paramref name="annotation"/>
    /// is the bare <c>@Attribute</c> sugar marker.
    /// </summary>
    /// <param name="annotation">The annotation node to test.</param>
    /// <returns>True for the marker.</returns>
    private static bool IsAttributeSugarMarker(AnnotationSyntax annotation)
    {
        if (annotation == null || annotation.Target != null)
        {
            return false;
        }

        if (annotation.NameSegments.Length != 1)
        {
            return false;
        }

        return annotation.NameSegments[0].Text == "Attribute";
    }

    /// <summary>
    /// Resolves a list of <see cref="AnnotationSyntax"/> nodes against the
    /// declaring scope and returns the bound attribute list per ADR-0047.
    /// </summary>
    /// <param name="annotations">Annotations from the declaration's syntax node.</param>
    /// <param name="defaultTarget">Default target inferred from the declaration position.</param>
    /// <param name="allowedTargets">Target kinds permitted at this declaration position.</param>
    /// <param name="positionDescription">Human-readable position for diagnostics.</param>
    /// <param name="defaultSystemTarget">CLR-side <see cref="System.AttributeTargets"/>
    /// value used when validating <c>[AttributeUsage(ValidOn)]</c> for the
    /// <c>Type</c> kind, which is ambiguous in source.</param>
    /// <returns>The resolved attribute list (skipping unresolved entries).</returns>
    private ImmutableArray<BoundAttribute> BindAttributes(
        ImmutableArray<AnnotationSyntax> annotations,
        AttributeTargetKind defaultTarget,
        ImmutableHashSet<AttributeTargetKind> allowedTargets,
        string positionDescription,
        System.AttributeTargets defaultSystemTarget)
    {
        if (annotations.IsDefaultOrEmpty)
        {
            return ImmutableArray<BoundAttribute>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<BoundAttribute>(annotations.Length);

        // Track applications per (attribute-type identity, effective target)
        // so we can fire GS0210 when AllowMultiple = false. We key on the
        // resolved TypeSymbol (reference identity is sufficient — each
        // attribute class has a single Symbol instance).
        var applications = new Dictionary<(TypeSymbol Type, AttributeTargetKind Target), int>();

        foreach (var annotation in annotations)
        {
            // Phase 4 of #141 / ADR-0047 §5: the `@Attribute` marker on a
            // class declaration is sugar — it does NOT participate in the
            // emitted CustomAttribute table. The struct binder consumes it
            // separately via HasAttributeSugarMarker.
            if (defaultTarget == AttributeTargetKind.Type && IsAttributeSugarMarker(annotation))
            {
                continue;
            }

            var bound = BindAttribute(annotation, defaultTarget, allowedTargets, positionDescription, defaultSystemTarget);
            if (bound != null)
            {
                var key = (bound.AttributeType, bound.Target);
                if (applications.TryGetValue(key, out var count))
                {
                    KnownAttributes.GetAttributeUsage(bound.AttributeType, out _, out var allowMultiple);
                    if (!allowMultiple)
                    {
                        Diagnostics.ReportAttributeUsageDuplicate(
                            GetAnnotationNameLocation(annotation),
                            annotation.GetNameText());
                    }

                    applications[key] = count + 1;
                }
                else
                {
                    applications[key] = 1;
                }

                builder.Add(bound);
            }
        }

        return builder.ToImmutable();
    }

    private BoundAttribute BindAttribute(
        AnnotationSyntax annotation,
        AttributeTargetKind defaultTarget,
        ImmutableHashSet<AttributeTargetKind> allowedTargets,
        string positionDescription,
        System.AttributeTargets defaultSystemTarget)
    {
        // 1) Resolve target — parser already filtered to canonical kinds; if
        // the user wrote an unrecognised one a GS0197 was already reported,
        // but we still need to map a parsed-but-unknown string back to a
        // sentinel. The closed set keys off ADR-0047 §2.
        var targetKind = defaultTarget;
        if (annotation.Target != null)
        {
            if (TryParseTargetKind(annotation.Target.KindIdentifier.Text, out var parsedTarget))
            {
                targetKind = parsedTarget;
            }
            else
            {
                // Already reported by the parser; treat as default and continue.
            }

            if (!allowedTargets.Contains(targetKind))
            {
                Diagnostics.ReportAttributeTargetInvalidForPosition(
                    annotation.Target.KindIdentifier.Location,
                    annotation.Target.KindIdentifier.Text,
                    positionDescription);
            }
        }

        // 2) Resolve attribute type (C#-style: `Foo` then `FooAttribute`).
        var nameText = annotation.GetNameText();
        var attrType = ResolveAttributeType(nameText, annotation, out var nameIsExact);
        if (attrType == null)
        {
            return null;
        }

        // 3) Validate it derives from System.Attribute.
        if (!IsAttributeType(attrType))
        {
            var displayName = nameIsExact ? nameText : (nameText + "Attribute");
            Diagnostics.ReportNotAnAttributeType(GetAnnotationNameLocation(annotation), displayName);
            return null;
        }

        // 3a) Reject user-written instances of attributes ADR-0047 §6
        // reserves for compiler synthesis (Extension, AsyncStateMachine,
        // CompilerGenerated, Nullable, NullableContext). Recognition is
        // type-identity based on the resolved CLR type so renaming or
        // shadowing the source-level name cannot bypass the rule.
        if (KnownAttributes.IsReservedForCompiler(attrType.ClrType))
        {
            Diagnostics.ReportAttributeReservedForCompiler(GetAnnotationNameLocation(annotation), nameText);
            return null;
        }

        // 3a.1) Issue #179 / ADR-0047 §6: recognise [DllImport] but reject it in
        // v1.0. The attribute is only valid on declarations whose body marker is
        // `extern`, which (together with the underlying P/Invoke metadata emit)
        // is a post-v1.0 feature. Type-identity recognition prevents aliasing
        // or shadowing the source-level name from bypassing the rule.
        if (KnownAttributes.IsDllImport(attrType.ClrType))
        {
            Diagnostics.ReportDllImportNotSupported(GetAnnotationNameLocation(annotation), nameText);
            return null;
        }

        // 3b) Issue #177 / ADR-0047 §6: enforce [AttributeUsage(ValidOn)].
        // For the `Type` target the actual CLR target depends on the kind
        // of type being declared (class/struct/enum/interface), which the
        // caller passes via defaultSystemTarget. For all other targets the
        // effective CLR target is derived directly from targetKind, since
        // any use-site qualifier (`@return:` etc.) already narrows it.
        var effectiveSystemTarget = MapToSystemAttributeTargets(targetKind, defaultSystemTarget);
        KnownAttributes.GetAttributeUsage(attrType, out var validOn, out _);
        if ((validOn & effectiveSystemTarget) == 0)
        {
            Diagnostics.ReportAttributeUsageInvalidTarget(
                GetAnnotationNameLocation(annotation),
                nameText,
                positionDescription,
                validOn);
            return null;
        }

        // 4) Bind arguments — positional + named — restricted to compile-time
        // constants. Named arguments come back from ParseArguments as
        // NamedArgumentExpressionSyntax wrappers.
        var positional = ImmutableArray.CreateBuilder<BoundAttributeArgument>();
        var named = ImmutableArray.CreateBuilder<BoundAttributeArgument>();
        if (annotation.Arguments != null)
        {
            foreach (var argSyntax in annotation.Arguments)
            {
                if (argSyntax is NamedArgumentExpressionSyntax namedArg)
                {
                    if (!TryBindAttributeArgument(namedArg.Expression, out var value, out var valueType))
                    {
                        Diagnostics.ReportAttributeArgumentNotConstant(namedArg.Expression.Location);
                        continue;
                    }

                    named.Add(new BoundAttributeArgument(namedArg.NameToken.Text, value, valueType));
                }
                else
                {
                    if (!TryBindAttributeArgument(argSyntax, out var value, out var valueType))
                    {
                        Diagnostics.ReportAttributeArgumentNotConstant(argSyntax.Location);
                        continue;
                    }

                    positional.Add(new BoundAttributeArgument(name: null, value, valueType));
                }
            }
        }

        return new BoundAttribute(annotation, attrType, targetKind, positional.ToImmutable(), named.ToImmutable());
    }

    private TypeSymbol ResolveAttributeType(string name, AnnotationSyntax annotation, out bool nameIsExact)
    {
        var nameLocation = GetAnnotationNameLocation(annotation);
        nameIsExact = true;

        // The dotted form (e.g. `System.Obsolete`) is not yet routed through
        // LookupType — fall back to a CLR walk by full name. v1 keeps
        // resolution focused on the single-identifier form; dotted names
        // remain a follow-up.
        var direct = LookupType(name);
        TypeSymbol suffixed = null;
        if (!string.IsNullOrEmpty(name) && !name.EndsWith("Attribute", StringComparison.Ordinal))
        {
            suffixed = LookupType(name + "Attribute");
        }

        if (direct != null && IsAttributeType(direct) && suffixed != null && IsAttributeType(suffixed))
        {
            Diagnostics.ReportAmbiguousAttributeName(nameLocation, name);
            return direct;
        }

        if (direct != null)
        {
            nameIsExact = true;
            return direct;
        }

        if (suffixed != null)
        {
            nameIsExact = false;
            return suffixed;
        }

        Diagnostics.ReportAttributeTypeNotFound(nameLocation, name);
        return null;
    }

    private static bool IsAttributeType(TypeSymbol typeSymbol)
    {
        if (typeSymbol is StructSymbol structSym && structSym.IsAttributeClass)
        {
            return true;
        }

        var clr = typeSymbol?.ClrType;
        if (clr == null)
        {
            return false;
        }

        var attributeFullName = typeof(System.Attribute).FullName;
        for (var t = clr; t != null; t = t.BaseType)
        {
            if (t.FullName == attributeFullName)
            {
                return true;
            }
        }

        return false;
    }

    private static TextLocation GetAnnotationNameLocation(AnnotationSyntax annotation)
    {
        if (!annotation.NameSegments.IsDefaultOrEmpty)
        {
            var first = annotation.NameSegments[0];
            var last = annotation.NameSegments[annotation.NameSegments.Length - 1];
            var span = TextSpan.FromBounds(first.Span.Start, last.Span.End);
            return new TextLocation(annotation.SyntaxTree.Text, span);
        }

        return annotation.Location;
    }

    private static bool IsEnumLikeType(TypeSymbol type)
    {
        if (type is EnumSymbol)
        {
            return true;
        }

        var clr = type?.ClrType;
        return clr != null && clr.IsEnum;
    }

    private static bool TryParseTargetKind(string text, out AttributeTargetKind kind)
    {
        switch (text)
        {
            case "field": kind = AttributeTargetKind.Field; return true;
            case "param": kind = AttributeTargetKind.Param; return true;
            case "return": kind = AttributeTargetKind.Return; return true;
            case "type": kind = AttributeTargetKind.Type; return true;
            case "method": kind = AttributeTargetKind.Method; return true;
            case "property": kind = AttributeTargetKind.Property; return true;
            case "event": kind = AttributeTargetKind.Event; return true;
            case "module": kind = AttributeTargetKind.Module; return true;
            case "assembly": kind = AttributeTargetKind.Assembly; return true;
            case "genericparam": kind = AttributeTargetKind.GenericParam; return true;
            default: kind = AttributeTargetKind.Method; return false;
        }
    }

    /// <summary>
    /// Issue #177: maps a GSharp <see cref="AttributeTargetKind"/> to the
    /// corresponding CLR <see cref="System.AttributeTargets"/> flag used by
    /// <see cref="System.AttributeUsageAttribute"/>. The <c>Type</c> kind
    /// is intentionally ambiguous in GSharp (class/struct/enum/interface
    /// share a single source-level position), so the caller supplies the
    /// concrete CLR target via <paramref name="typePositionFallback"/>.
    /// </summary>
    private static System.AttributeTargets MapToSystemAttributeTargets(AttributeTargetKind kind, System.AttributeTargets typePositionFallback)
    {
        switch (kind)
        {
            case AttributeTargetKind.Field: return System.AttributeTargets.Field;
            case AttributeTargetKind.Param: return System.AttributeTargets.Parameter;
            case AttributeTargetKind.Return: return System.AttributeTargets.ReturnValue;
            case AttributeTargetKind.Method: return System.AttributeTargets.Method;
            case AttributeTargetKind.Property: return System.AttributeTargets.Property;
            case AttributeTargetKind.Event: return System.AttributeTargets.Event;
            case AttributeTargetKind.Module: return System.AttributeTargets.Module;
            case AttributeTargetKind.Assembly: return System.AttributeTargets.Assembly;
            case AttributeTargetKind.GenericParam: return System.AttributeTargets.GenericParameter;
            case AttributeTargetKind.Type: return typePositionFallback;
            default: return System.AttributeTargets.All;
        }
    }

    /// <summary>
    /// Tries to bind an attribute argument expression as a compile-time
    /// constant value of one of the shapes permitted by ECMA-335 II.23.3 /
    /// ADR-0047 §3: literal (numeric, char, string, bool, nil), a
    /// <c>typeof(T)</c> expression (carried as the resolved CLR
    /// <see cref="Type"/>), or a single-dimensional array literal of any
    /// supported element shape. Returns <c>false</c> for any expression the
    /// emitter cannot serialise.
    /// </summary>
    /// <param name="syntax">The argument expression.</param>
    /// <param name="value">The extracted compile-time value when the method returns <c>true</c>.</param>
    /// <param name="type">The static type carried by the argument when the method returns <c>true</c>.</param>
    /// <returns><c>true</c> if the expression maps to a supported attribute constant; otherwise <c>false</c>.</returns>
    private bool TryBindAttributeArgument(ExpressionSyntax syntax, out object value, out TypeSymbol type)
    {
        value = null;
        type = null;

        switch (syntax)
        {
            case LiteralExpressionSyntax literal:
                if (BindExpression(literal) is BoundLiteralExpression bl)
                {
                    value = bl.Value;
                    type = bl.Type;
                    return true;
                }

                return false;

            case TypeOfExpressionSyntax typeOfSyntax:
                if (BindTypeOfExpression(typeOfSyntax) is BoundTypeOfExpression bt
                    && bt.OperandType?.ClrType is { } clr)
                {
                    value = clr;
                    type = bt.Type;
                    return true;
                }

                return false;

            case ArrayCreationExpressionSyntax arraySyntax:
                return TryBindAttributeArrayArgument(arraySyntax, out value, out type);
        }

        // Issue #177: accept BoundLiteralExpression whose static type is an
        // enum (e.g. `AttributeTargets.Method`) — required by [AttributeUsage]
        // and other enum-valued attribute arguments. The emitter serialises
        // the underlying primitive per ECMA-335 II.23.3. Other expressions
        // that incidentally fold to a constant (e.g. `nameof(...)`) remain
        // out of scope here; they go through GS0202.
        if (BindExpression(syntax) is BoundLiteralExpression lit
            && lit.Value != null
            && IsEnumLikeType(lit.Type))
        {
            value = lit.Value;
            type = lit.Type;
            return true;
        }

        return false;
    }

    private bool TryBindAttributeArrayArgument(
        ArrayCreationExpressionSyntax syntax,
        out object value,
        out TypeSymbol type)
    {
        value = null;
        type = null;

        if (BindArrayCreationExpression(syntax) is not BoundArrayCreationExpression bound)
        {
            return false;
        }

        // Attribute arrays must be a serialisable SZARRAY (1-D) shape per
        // ECMA-335 II.23.3. Both `[]T{...}` (slice) and `[N]T{...}` (array)
        // produce a CLR `T[]` for the element type clause.
        var clrArrayType = bound.Type?.ClrType;
        if (clrArrayType == null || !clrArrayType.IsArray || clrArrayType.GetArrayRank() != 1)
        {
            return false;
        }

        var elementClrType = clrArrayType.GetElementType();
        if (elementClrType == null)
        {
            return false;
        }

        var result = Array.CreateInstance(elementClrType, syntax.Elements.Count);
        for (int i = 0; i < syntax.Elements.Count; i++)
        {
            if (!TryBindAttributeArgument(syntax.Elements[i], out var elementValue, out _))
            {
                return false;
            }

            try
            {
                result.SetValue(CoerceAttributeElement(elementValue, elementClrType), i);
            }
            catch
            {
                return false;
            }
        }

        value = result;
        type = bound.Type;
        return true;
    }

    private static object CoerceAttributeElement(object value, Type elementType)
    {
        if (value == null || elementType.IsInstanceOfType(value))
        {
            return value;
        }

        if (elementType.IsEnum)
        {
            var underlying = Enum.GetUnderlyingType(elementType);
            return Convert.ChangeType(value, underlying, System.Globalization.CultureInfo.InvariantCulture);
        }

        // Numeric / char widening between primitives (e.g. int → long).
        return Convert.ChangeType(value, elementType, System.Globalization.CultureInfo.InvariantCulture);
    }

    private sealed class CapturedVariableCollector : BoundTreeRewriter
    {
        private readonly HashSet<VariableSymbol> parameters;
        private readonly HashSet<VariableSymbol> seen;
        private readonly HashSet<VariableSymbol> declared;
        private readonly ImmutableArray<VariableSymbol>.Builder captured;

        public CapturedVariableCollector(
            HashSet<VariableSymbol> parameters,
            HashSet<VariableSymbol> seen,
            ImmutableArray<VariableSymbol>.Builder captured)
        {
            this.parameters = parameters;
            this.seen = seen;
            this.declared = new HashSet<VariableSymbol>();
            this.captured = captured;
        }

        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            this.declared.Add(node.Variable);
            return base.RewriteVariableDeclaration(node);
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            if (!this.parameters.Contains(node.Variable)
                && !this.declared.Contains(node.Variable)
                && this.seen.Add(node.Variable))
            {
                this.captured.Add(node.Variable);
            }

            return node;
        }
    }
}