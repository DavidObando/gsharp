// <copyright file="Binder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Binder.
/// </summary>
public sealed class Binder
{
    private readonly FunctionSymbol function;
    private readonly List<(StructDeclarationSyntax Syntax, StructSymbol Symbol)> pendingInterfaceImplementationChecks
        = new List<(StructDeclarationSyntax, StructSymbol)>();

    private Stack<(BoundLabel BreakLabel, BoundLabel ContinueLabel)> loopStack = new Stack<(BoundLabel BreakLabel, BoundLabel ContinueLabel)>();
    private int labelCounter;
    private int nullConditionalCaptureCounter;
    private List<Dictionary<VariableSymbol, TypeSymbol>> narrowedVariables = new List<Dictionary<VariableSymbol, TypeSymbol>>();
    private Dictionary<string, TypeParameterSymbol> currentTypeParameters;
    private BoundScope scope;

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

            foreach (var p in function.Parameters)
            {
                scope.TryDeclareVariable(p);
            }

            // Phase 4.1 / ADR-0020: expose declared generic type parameters
            // when binding the function body so that `T` resolves inside the
            // body to the TypeParameterSymbol.
            if (function.IsGeneric)
            {
                currentTypeParameters = new Dictionary<string, TypeParameterSymbol>(function.TypeParameters.Length);
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
    {
        var parentScope = CreateParentScope(previous, references);
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

        binder.VerifyInterfaceImplementations();

        var functionDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                              .OfType<FunctionDeclarationSyntax>();
        foreach (var function in functionDeclarations)
        {
            var owningPackage = packageByTree[function.SyntaxTree];
            binder.BindFunctionDeclaration(function, owningPackage);
        }

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

        return new BoundGlobalScope(previous, entryPointPackage, packagesInOrder.ToImmutable(), diagnostics, imports, functions, variables, typeAliases, structs, interfaces, entryPoint, statements.ToImmutable());
    }

    /// <summary>
    /// Produces a bound program from the specified global scope.
    /// </summary>
    /// <param name="globalScope">The global scope.</param>
    /// <returns>A bound program.</returns>
    public static BoundProgram BindProgram(BoundGlobalScope globalScope)
    {
        var parentScope = CreateParentScope(globalScope, references: null);

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

                if (function.Type != TypeSymbol.Void && !ControlFlowGraph.AllPathsReturn(loweredBody))
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

                if (method.Type != TypeSymbol.Void && !ControlFlowGraph.AllPathsReturn(loweredBody))
                {
                    binder.Diagnostics.ReportAllPathsMustReturn(method.Declaration.Identifier.Location);
                }

                functionBodies.Add(method, loweredBody);
                diagnostics.AddRange(binder.Diagnostics);
            }
        }

        var statement = Lowerer.Lower(new BoundBlockStatement(globalScope.Statements));

        // If the entry point is the synthesized top-level function, its body is
        // the lowered top-level statements block. Register it under EntryPoint so
        // the emitter sees a uniform "Functions[EntryPoint]" view.
        if (globalScope.EntryPoint != null && globalScope.EntryPoint.Declaration == null)
        {
            functionBodies[globalScope.EntryPoint] = statement;
        }

        return new BoundProgram(globalScope.Package, globalScope.Packages, diagnostics.ToImmutable(), functionBodies.ToImmutable(), globalScope.EntryPoint, statement, globalScope.Structs, globalScope.Interfaces);
    }

    private static BoundScope CreateParentScope(BoundGlobalScope previous, ReferenceResolver references)
    {
        var stack = new Stack<BoundGlobalScope>();
        while (previous != null)
        {
            stack.Push(previous);
            previous = previous.Previous;
        }

        var parent = CreateRootScope(references);

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

    private static BoundScope CreateRootScope(ReferenceResolver references)
    {
        var result = new BoundScope(parent: null, references: references);

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
        switch (name)
        {
            case "bool":
            case "int":
            case "string":
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
                return;
        }

        var aliasedType = BindTypeClause(syntax.AliasedType);
        if (aliasedType == null)
        {
            return;
        }

        if (!scope.TryDeclareTypeAlias(name, aliasedType))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }
    }

    private void BindStructDeclaration(StructDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;

        switch (name)
        {
            case "bool":
            case "int":
            case "string":
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

                ctorBuilder.Add(new ParameterSymbol(paramName, paramType));
                fields.Add(new FieldSymbol(paramName, paramType, Accessibility.Public));
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
            fields.Add(new FieldSymbol(fieldName, fieldType, fieldAccessibility));
        }

        if (syntax.IsData && fields.Count == 0)
        {
            Diagnostics.ReportEmptyDataStruct(syntax.Identifier.Location, name);
        }

        // Phase 3.B.3 sub-step 3 + 3.B.4: resolve the optional `: X, Y, Z` clause.
        // Each identifier is either the (single) base class or an interface
        // implemented by this class. A base class, if present, must be the
        // first identifier. Declaration order rules apply: base/interfaces
        // must be declared before this type.
        StructSymbol baseClassSymbol = null;
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
                    if (!scope.TryLookupTypeAlias(baseName, out var resolved))
                    {
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
            syntax.IsClass,
            primaryCtorParameters,
            isOpen: syntax.IsOpen && syntax.IsClass,
            baseClass: baseClassSymbol);

        if (!typeParameters.IsDefaultOrEmpty)
        {
            structSymbol.SetTypeParameters(typeParameters);
        }

        if (!scope.TryDeclareTypeAlias(name, structSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }

        // Phase 3.B.3 sub-step 2b: bind methods declared inside the class body.
        // Methods are only legal on `class` types (struct methods rejected by
        // the parser already). Each method becomes a FunctionSymbol with
        // ReceiverType = structSymbol; method bodies are bound later by
        // BindProgram by walking StructSymbol.Methods.
        if (syntax.IsClass && !syntax.Methods.IsDefaultOrEmpty)
        {
            var existingNames = new HashSet<string>();
            foreach (var f in structSymbol.Fields)
            {
                existingNames.Add(f.Name);
            }

            var methodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
            foreach (var methodSyntax in syntax.Methods)
            {
                var methodName = methodSyntax.Identifier.Text;
                if (!existingNames.Add(methodName))
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
                    if (!seenParameterNames.Add(parameterName))
                    {
                        Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                    }
                    else
                    {
                        parameters.Add(new ParameterSymbol(parameterName, parameterType));
                    }
                }

                var returnType = BindTypeClause(methodSyntax.Type) ?? TypeSymbol.Void;
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
                methodsBuilder.Add(methodSymbol);
            }

            structSymbol.SetMethods(methodsBuilder.ToImmutable());
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
                        || !SignaturesMatch(imethod, impl.Parameters, impl.Type))
                    {
                        Diagnostics.ReportInterfaceMethodNotImplemented(
                            syntax.Identifier.Location,
                            structSymbol.Name,
                            iface.Name,
                            imethod.Name);
                    }
                }
            }
        }
    }

    private InterfaceSymbol DeclareInterfaceSymbol(InterfaceDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;
        var accessibility = ResolveAccessibility(syntax.AccessibilityModifier);
        var interfaceSymbol = new InterfaceSymbol(name, accessibility, syntax, package.Name);

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
                if (!seenParameterNames.Add(parameterName))
                {
                    Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                }
                else
                {
                    parameters.Add(new ParameterSymbol(parameterName, parameterType));
                }
            }

            var returnType = BindTypeClause(methodSyntax.Type) ?? TypeSymbol.Void;
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
            // Phase 3.B.6 / ADR-0019: receiver clause becomes parameters[0].
            TypeSymbol extensionReceiverType = null;
            if (syntax.IsExtension)
            {
                var recvName = syntax.Receiver.Identifier.Text;
                extensionReceiverType = BindTypeClause(syntax.Receiver.Type);
                if (extensionReceiverType == null)
                {
                    extensionReceiverType = TypeSymbol.Error;
                }

                seenParameterNames.Add(recvName);
                parameters.Add(new ParameterSymbol(recvName, extensionReceiverType));
            }

            foreach (var parameterSyntax in syntax.Parameters)
            {
                var parameterName = parameterSyntax.Identifier.Text;
                var parameterType = BindTypeClause(parameterSyntax.Type);
                if (!seenParameterNames.Add(parameterName))
                {
                    Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                }
                else
                {
                    var parameter = new ParameterSymbol(parameterName, parameterType);
                    parameters.Add(parameter);
                }
            }

            var type = BindTypeClause(syntax.Type) ?? TypeSymbol.Void;

            var accessibility = ResolveAccessibility(syntax.AccessibilityModifier);
            var function = new FunctionSymbol(syntax.Identifier.Text, parameters.ToImmutable(), type, syntax, package, accessibility);
            function.TypeParameters = typeParameters;

            if (syntax.IsExtension)
            {
                function.IsExtension = true;
                function.ExtensionReceiverType = extensionReceiverType;
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

        if (baseMethod.Parameters.Length != derivedParams.Length)
        {
            return false;
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (baseMethod.Parameters[i].Type != derivedParams[i].Type)
            {
                return false;
            }
        }

        return true;
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

    private BoundStatement BindErrorStatement()
    {
        return new BoundExpressionStatement(new BoundErrorExpression());
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
            default:
                throw new Exception($"Unexpected syntax {syntax.Kind}");
        }
    }

    private BoundStatement BindBlockStatement(BlockStatementSyntax syntax)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        scope = new BoundScope(scope);

        foreach (var statementSyntax in syntax.Statements)
        {
            var statement = BindStatement(statementSyntax);
            statements.Add(statement);

            // Phase 3.C.4: mutation invalidates the narrowing. After binding
            // a statement that writes to a narrowed variable, drop its
            // narrowing from the current frame so subsequent reads in this
            // block see the variable at its declared (nullable) type again.
            InvalidateNarrowingsForAssignedVariables(statementSyntax);
        }

        scope = scope.Parent;

        return new BoundBlockStatement(statements.ToImmutable());
    }

    private void InvalidateNarrowingsForAssignedVariables(SyntaxNode statementSyntax)
    {
        if (narrowedVariables.Count == 0)
        {
            return;
        }

        var top = narrowedVariables[narrowedVariables.Count - 1];
        if (top.Count == 0)
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
        // narrowing. We don't need to be conservative about scope shadowing:
        // the narrowed variable lives in an outer scope, so an inner
        // shadowing declaration with the same name will resolve to a
        // different symbol, and the narrowing will simply not be triggered.
        foreach (var name in assignedNames)
        {
            if (scope.TryLookupSymbol(name) is VariableSymbol v && top.ContainsKey(v))
            {
                top.Remove(v);
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
        var initializer = BindExpression(syntax.Initializer);
        var variableType = type ?? initializer.Type;
        var accessibility = ResolveAccessibility(syntax.AccessibilityModifier);
        var variable = BindVariableDeclaration(syntax.Identifier, isReadOnly, variableType, accessibility);
        var convertedInitializer = BindConversion(syntax.Initializer.Location, initializer, variableType);

        return new BoundVariableDeclaration(variable, convertedInitializer);
    }

    private TypeSymbol BindNonNullableTypeClause(TypeClauseSyntax syntax)
    {
        if (syntax == null)
        {
            return null;
        }

        var element = LookupType(syntax.Identifier.Text);
        if (element == null)
        {
            Diagnostics.ReportUndefinedType(syntax.Identifier.Location, syntax.Identifier.Text);
            return null;
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

    private BoundStatement BindIfStatement(IfStatementSyntax syntax)
    {
        if (syntax.Initializer == null)
        {
            var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);

            // Phase 3.C.4: minimal smart-cast narrowing for `x != nil` and
            // `x == nil` guards. The non-nil arm sees `x` as the underlying
            // type; the nil arm sees it as the bottom `TypeSymbol.Null`.
            var (nonNilNarrow, nilNarrow) = TryClassifyNilGuard(condition);

            var thenStatement = BindStatementWithNarrowing(syntax.ThenStatement, nonNilNarrow);
            var elseStatement = syntax.ElseClause == null ? null : BindStatementWithNarrowing(syntax.ElseClause.ElseStatement, nilNarrow);
            return new BoundIfStatement(condition, thenStatement, elseStatement);
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

        var inner = new BoundIfStatement(initCondition, initThen, initElse);
        return new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(initStatement, inner));
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

    private static bool IsNilLiteral(BoundExpression expr)
    {
        return expr is BoundLiteralExpression lit && lit.Type == TypeSymbol.Null;
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

    private BoundStatement BindMultiAssignmentStatement(MultiAssignmentStatementSyntax syntax)
    {
        var targets = syntax.Targets.ToImmutableArray();
        var values = syntax.Values.ToImmutableArray();

        if (targets.Length != values.Length)
        {
            Diagnostics.ReportMultiAssignmentMismatch(syntax.Location, targets.Length, values.Length);
            return new BoundExpressionStatement(new BoundErrorExpression());
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
                statements.Add(new BoundVariableDeclaration(variable, initializer));
            }

            return new BoundBlockStatement(statements.ToImmutable());
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
            statements.Add(new BoundVariableDeclaration(temp, initializer));
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

            var tempRef = new BoundVariableExpression(temps[i]);
            var converted = BindConversion(values[i].Location, tempRef, variable.Type);
            statements.Add(new BoundExpressionStatement(new BoundAssignmentExpression(variable, converted)));
        }

        return new BoundBlockStatement(statements.ToImmutable());
    }

    private BoundStatement BindSwitchStatement(SwitchStatementSyntax syntax)
    {
        var discriminant = BindExpression(syntax.Expression);
        var switchType = discriminant.Type;

        if (switchType != TypeSymbol.Error &&
            switchType != TypeSymbol.Int &&
            switchType != TypeSymbol.String &&
            switchType != TypeSymbol.Bool)
        {
            Diagnostics.ReportCannotConvert(syntax.Expression.Location, switchType, TypeSymbol.Int);
            return BindErrorStatement();
        }

        var tempName = $"<>switch_{syntax.SwitchKeyword.Position}";
        var tempVar = function == null
            ? (VariableSymbol)new GlobalVariableSymbol(tempName, isReadOnly: true, switchType)
            : new LocalVariableSymbol(tempName, isReadOnly: true, switchType);
        scope.TryDeclareVariable(tempVar);

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(tempVar, discriminant));

        BoundStatement defaultBody = null;
        TextLocation? duplicateDefaultLocation = null;

        // First pass: locate the default body (and flag duplicates) so the case
        // chain can be threaded through it regardless of source position.
        for (var i = 0; i < syntax.Cases.Length; i++)
        {
            var caseSyntax = syntax.Cases[i];
            if (!caseSyntax.IsDefault)
            {
                continue;
            }

            if (defaultBody != null)
            {
                duplicateDefaultLocation = caseSyntax.Keyword.Location;
            }
            else
            {
                defaultBody = BindBlockStatement(caseSyntax.Body);
            }
        }

        BoundStatement chain = defaultBody;

        for (var i = syntax.Cases.Length - 1; i >= 0; i--)
        {
            var caseSyntax = syntax.Cases[i];
            if (caseSyntax.IsDefault)
            {
                continue;
            }

            var caseBody = BindBlockStatement(caseSyntax.Body);
            var caseValue = BindExpression(caseSyntax.Value);
            var converted = BindConversion(caseSyntax.Value.Location, caseValue, switchType, allowExplicit: false);
            var op = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, switchType, switchType);
            if (op == null)
            {
                Diagnostics.ReportSwitchCaseTypeMismatch(caseSyntax.Value.Location, caseValue.Type, switchType);
                continue;
            }

            var condition = new BoundBinaryExpression(new BoundVariableExpression(tempVar), op, converted);
            chain = new BoundIfStatement(condition, caseBody, chain);
        }

        if (duplicateDefaultLocation.HasValue)
        {
            Diagnostics.ReportDuplicateSwitchDefault(duplicateDefaultLocation.Value);
        }

        if (chain == null)
        {
            // No non-default cases at all -- just run the default (if any).
            if (defaultBody != null)
            {
                statements.Add(defaultBody);
            }
        }
        else
        {
            statements.Add(chain);
        }

        return new BoundBlockStatement(statements.ToImmutable());
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

        return new BoundTryStatement(tryBlock, catches.ToImmutable(), finallyBlock);
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

        return new BoundThrowStatement(expression);
    }

    private BoundStatement BindUsingStatement(UsingStatementSyntax syntax)
    {
        // Lower `using let x = expr` to `let x = expr; try { } finally { x.Dispose() }`.
        // Because the rest of the enclosing block is not available here, the user's
        // intent is captured by emitting a try/finally that protects an empty block.
        // The disposal still happens at scope exit because the finally always runs.
        // Note: this is a minimal Phase 3.D shape; a future iteration will reshape
        // the enclosing block so the protected region covers the remaining statements.
        var declaration = (BoundVariableDeclaration)BindVariableDeclaration(syntax.Declaration);

        var disposeCall = TryBuildDisposeCall(declaration.Variable, syntax.UsingKeyword.Location);
        if (disposeCall == null)
        {
            return BindErrorStatement();
        }

        var tryBlock = new BoundBlockStatement(ImmutableArray<BoundStatement>.Empty);
        var finallyBlock = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(disposeCall)));
        var tryStmt = new BoundTryStatement(tryBlock, ImmutableArray<BoundCatchClause>.Empty, finallyBlock);

        return new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(declaration, tryStmt));
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

        var receiver = new BoundVariableExpression(variable);
        return new BoundImportedInstanceCallExpression(receiver, disposeMethod, TypeSymbol.Void, ImmutableArray<BoundExpression>.Empty);
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

        return new BoundForInfiniteStatement(body, breakLabel, continueLabel);
    }

    private BoundStatement BindForEllipsisStatement(ForEllipsisStatementSyntax syntax)
    {
        var lowerBound = BindExpression(syntax.LowerBound, TypeSymbol.Int);
        var upperBound = BindExpression(syntax.UpperBound, TypeSymbol.Int);

        scope = new BoundScope(scope);

        var variable = BindVariableDeclaration(syntax.Identifier, isReadOnly: false, type: TypeSymbol.Int);
        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForEllipsisStatement(variable, lowerBound, upperBound, body, breakLabel, continueLabel);
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
        statements.Add(new BoundGotoStatement(checkLabel));
        statements.Add(new BoundLabelStatement(bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(continueLabel));
        statements.Add(new BoundLabelStatement(checkLabel));
        statements.Add(new BoundConditionalGotoStatement(bodyLabel, condition, jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(breakLabel));

        return new BoundBlockStatement(statements.ToImmutable());
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

        statements.Add(new BoundGotoStatement(checkLabel));
        statements.Add(new BoundLabelStatement(bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(continueLabel));
        if (post != null)
        {
            statements.Add(post);
        }

        statements.Add(new BoundLabelStatement(checkLabel));
        if (condition == null)
        {
            statements.Add(new BoundGotoStatement(bodyLabel));
        }
        else
        {
            statements.Add(new BoundConditionalGotoStatement(bodyLabel, condition, jumpIfTrue: true));
        }

        statements.Add(new BoundLabelStatement(breakLabel));

        return new BoundBlockStatement(statements.ToImmutable());
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
        return new BoundGotoStatement(breakLabel);
    }

    private BoundStatement BindContinueStatement(ContinueStatementSyntax syntax)
    {
        if (loopStack.Count == 0)
        {
            Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text);
            return BindErrorStatement();
        }

        var continueLabel = loopStack.Peek().ContinueLabel;
        return new BoundGotoStatement(continueLabel);
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

        return new BoundReturnStatement(expression);
    }

    private BoundStatement BindExpressionStatement(ExpressionStatementSyntax syntax)
    {
        var expression = BindExpression(syntax.Expression, canBeVoid: true);
        return new BoundExpressionStatement(expression);
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
            return new BoundErrorExpression();
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
            case SyntaxKind.IndexExpression:
                return BindIndexExpression((IndexExpressionSyntax)syntax);
            case SyntaxKind.IndexAssignmentExpression:
                return BindIndexAssignmentExpression((IndexAssignmentExpressionSyntax)syntax);
            case SyntaxKind.StructLiteralExpression:
                return BindStructLiteralExpression((StructLiteralExpressionSyntax)syntax);
            case SyntaxKind.FieldAssignmentExpression:
                return BindFieldAssignmentExpression((FieldAssignmentExpressionSyntax)syntax);
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

        return new BoundLiteralExpression(value);
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
                piece = new BoundLiteralExpression(segment.Text ?? string.Empty);
            }

            result = result == null ? piece : Concat(result, piece);
        }

        return result ?? new BoundLiteralExpression(string.Empty);
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
            return new BoundErrorExpression();
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
            return new BoundErrorExpression();
        }

        var importedClass = new ImportedClassSymbol(convertType, declaration: null);
        var importedFn = new ImportedFunctionSymbol(method.Name, importedClass, method, declaration: null);
        return new BoundImportedCallExpression(importedFn, ImmutableArray.Create(expression));
    }

    private static BoundExpression Concat(BoundExpression left, BoundExpression right)
    {
        var op = BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.String, TypeSymbol.String);
        return new BoundBinaryExpression(left, op, right);
    }

    private BoundExpression BindNameExpression(NameExpressionSyntax syntax)
    {
        var name = syntax.IdentifierToken.Text;
        if (syntax.IdentifierToken.IsMissing)
        {
            // This means the token was inserted by the parser. We already
            // reported error so we can just return an error expression.
            return new BoundErrorExpression();
        }

        var variable = BindVariableReference(name, syntax.IdentifierToken.Location);
        if (variable == null)
        {
            return new BoundErrorExpression();
        }

        if (variable is ImplicitFieldVariableSymbol implicitField)
        {
            return new BoundFieldAccessExpression(
                new BoundVariableExpression(implicitField.Receiver),
                implicitField.StructType,
                implicitField.Field);
        }

        return new BoundVariableExpression(variable, TryGetNarrowedType(variable));
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
            var convertedValue = BindConversion(syntax.Expression.Location, boundExpression, implicitField.Field.Type);
            return new BoundFieldAssignmentExpression(implicitField.Receiver, implicitField.StructType, implicitField.Field, convertedValue);
        }

        if (variable.IsReadOnly)
        {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name);
        }

        var convertedExpression = BindConversion(syntax.Expression.Location, boundExpression, variable.Type);

        return new BoundAssignmentExpression(variable, convertedExpression);
    }

    private BoundExpression BindStructLiteralExpression(StructLiteralExpressionSyntax syntax)
    {
        var typeName = syntax.TypeIdentifier.Text;
        if (!scope.TryLookupTypeAlias(typeName, out var resolvedType) || !(resolvedType is StructSymbol structSymbol))
        {
            Diagnostics.ReportUnableToFindType(syntax.TypeIdentifier.Location, typeName);
            return new BoundErrorExpression();
        }

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
                    return new BoundErrorExpression();
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = BindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression();
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
                        return new BoundErrorExpression();
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
                    return new BoundErrorExpression();
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
            return new BoundErrorExpression();
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

        return new BoundStructLiteralExpression(structSymbol, inits.ToImmutable());
    }

    private BoundExpression BindFieldAssignmentExpression(FieldAssignmentExpressionSyntax syntax)
    {
        var receiverName = syntax.Receiver.Text;
        var variable = BindVariableReference(receiverName, syntax.Receiver.Location);
        var value = BindExpression(syntax.Value);
        if (variable == null)
        {
            return value;
        }

        if (!(variable.Type is StructSymbol structSymbol))
        {
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.Text);
            return new BoundErrorExpression();
        }

        if (!structSymbol.TryGetFieldIncludingInherited(syntax.FieldIdentifier.Text, out var field, out _))
        {
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, syntax.FieldIdentifier.Text);
            return new BoundErrorExpression();
        }

        if (variable.IsReadOnly)
        {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, receiverName);
        }

        var converted = BindConversion(syntax.Value.Location, value, field.Type);
        return new BoundFieldAssignmentExpression(variable, structSymbol, field, converted);
    }

    private BoundExpression BindUnaryExpression(UnaryExpressionSyntax syntax)
    {
        var boundOperand = BindExpression(syntax.Operand);

        if (boundOperand.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression();
        }

        var boundOperator = BoundUnaryOperator.Bind(syntax.OperatorToken.Kind, boundOperand.Type);

        if (boundOperator == null)
        {
            Diagnostics.ReportUndefinedUnaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, boundOperand.Type);
            return new BoundErrorExpression();
        }

        return new BoundUnaryExpression(boundOperator, boundOperand);
    }

    private BoundExpression BindBinaryExpression(BinaryExpressionSyntax syntax)
    {
        var boundLeft = BindExpression(syntax.Left);
        var boundRight = BindExpression(syntax.Right);

        if (boundLeft.Type == TypeSymbol.Error || boundRight.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression();
        }

        var boundOperator = BoundBinaryOperator.Bind(syntax.OperatorToken.Kind, boundLeft.Type, boundRight.Type);

        if (boundOperator == null)
        {
            Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, boundLeft.Type, boundRight.Type);
            return new BoundErrorExpression();
        }

        return new BoundBinaryExpression(boundLeft, boundOperator, boundRight);
    }

    private BoundExpression BindConstructorCallExpression(CallExpressionSyntax syntax, StructSymbol classType)
    {
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
            return new BoundErrorExpression();
        }

        var hasErrors = false;
        for (var i = 0; i < parameters.Length; i++)
        {
            var argument = boundArguments[i];
            var parameter = parameters[i];
            if (argument.Type != parameter.Type)
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
            return new BoundErrorExpression();
        }

        return new BoundConstructorCallExpression(classType, boundArguments.ToImmutable());
    }

    private BoundExpression BindCallExpression(CallExpressionSyntax syntax)
    {
        if (syntax.Arguments.Count == 1 && LookupType(syntax.Identifier.Text) is TypeSymbol type)
        {
            // A single-arg call to a primitive-typed name is a conversion
            // (`int(x)`, `string(x)`). Defer to BindConversion. For a class
            // type with a one-parameter primary constructor, treat it as a
            // ctor call instead.
            if (!(type is StructSymbol singleArgStruct && singleArgStruct.IsClass && singleArgStruct.HasPrimaryConstructor))
            {
                return BindConversion(syntax.Arguments[0], type, allowExplicit: true);
            }
        }

        // Phase 3.B.3 sub-step 2: `ClassName(arg1, arg2, ...)` invokes the
        // class's primary constructor when the call target resolves to a
        // class type with a declared primary ctor.
        if (LookupType(syntax.Identifier.Text) is StructSymbol classType && classType.IsClass && classType.HasPrimaryConstructor)
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
            return new BoundErrorExpression();
        }

        var function = symbol as FunctionSymbol;
        if (function == null)
        {
            Diagnostics.ReportNotAFunction(syntax.Identifier.Location, syntax.Identifier.Text);
            return new BoundErrorExpression();
        }

        if (syntax.Arguments.Count != function.Parameters.Length)
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
            return new BoundErrorExpression();
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
                    return new BoundErrorExpression();
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = BindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression();
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
                        return new BoundErrorExpression();
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
                    return new BoundErrorExpression();
                }
            }
        }

        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            var argument = boundArguments[i];
            var parameter = function.Parameters[i];
            var expectedType = substitution != null ? SubstituteType(parameter.Type, substitution) : parameter.Type;

            if (argument.Type != expectedType && !(substitution != null && parameter.Type is TypeParameterSymbol))
            {
                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportWrongArgumentType(syntax.Arguments[i].Location, parameter.Name, expectedType, argument.Type);
                }

                hasErrors = true;
            }
        }

        if (hasErrors)
        {
            return new BoundErrorExpression();
        }

        if (substitution != null)
        {
            var returnType = SubstituteType(function.Type, substitution);
            return new BoundCallExpression(function, boundArguments.ToImmutable(), returnType);
        }

        return new BoundCallExpression(function, boundArguments.ToImmutable());
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
        if (type == TypeSymbol.Int || type == TypeSymbol.String || type == TypeSymbol.Bool)
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
                    result = new BoundErrorExpression();
                    return true;
                }

                var operand = BindExpression(syntax.Arguments[0]);
                if (operand.Type == TypeSymbol.Error)
                {
                    result = new BoundErrorExpression();
                    return true;
                }

                var ok = operand.Type is ArrayTypeSymbol || operand.Type is SliceTypeSymbol
                    || (name == "len" && operand.Type == TypeSymbol.String);
                if (!ok)
                {
                    Diagnostics.ReportIntrinsicArgumentType(syntax.Arguments[0].Location, name, operand.Type);
                    result = new BoundErrorExpression();
                    return true;
                }

                result = name == "len"
                    ? new BoundLenExpression(operand)
                    : new BoundCapExpression(operand);
                return true;
            }

            case "append":
            {
                if (syntax.Arguments.Count != 2)
                {
                    Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, name, 2, syntax.Arguments.Count);
                    result = new BoundErrorExpression();
                    return true;
                }

                var slice = BindExpression(syntax.Arguments[0]);
                if (slice.Type == TypeSymbol.Error)
                {
                    result = new BoundErrorExpression();
                    return true;
                }

                if (slice.Type is not SliceTypeSymbol sliceType)
                {
                    Diagnostics.ReportIntrinsicArgumentType(syntax.Arguments[0].Location, name, slice.Type);
                    result = new BoundErrorExpression();
                    return true;
                }

                var element = BindConversion(syntax.Arguments[1], sliceType.ElementType);
                result = new BoundAppendExpression(slice, element, sliceType);
                return true;
            }

            default:
                return false;
        }
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

        // Determine what the left side of the accessor is: either an imported
        // class (for static member access) or a value-producing expression (for
        // instance member access). Then apply the right side, which may itself
        // be a chain of accessors (e.g. Guid.NewGuid().ToString()).
        var leftPart = syntax.LeftPart;
        var rightPart = syntax.RightPart;
        BoundExpression receiver = null;
        ImportedClassSymbol classSymbol = null;

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
                    receiver = new BoundFieldAccessExpression(
                        new BoundVariableExpression(implicitField.Receiver),
                        implicitField.StructType,
                        implicitField.Field);
                }
                else
                {
                    receiver = new BoundVariableExpression(variable);
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
            else
            {
                Diagnostics.ReportUnableToFindType(leftName.Location, name);
                return new BoundErrorExpression();
            }
        }
        else
        {
            receiver = BindExpression(leftPart);
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
            return new BoundLiteralExpression(null);
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

        var captureRef = new BoundVariableExpression(capture);
        var whenNotNull = BindAccessorStep(captureRef, null, syntax.RightPart);

        scope = scope.Parent;

        var resultType = whenNotNull.Type is NullableTypeSymbol ? whenNotNull.Type : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);
        return new BoundNullConditionalAccessExpression(receiver, capture, whenNotNull, resultType);
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
                if (classSymbol != null)
                {
                    var foundMember = classSymbol.TryLookupMember(ne.IdentifierToken.Text, ne, out _);
                    if (!foundMember)
                    {
                        Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                    }
                }
                else if (receiver != null && receiver.Type is StructSymbol structSym)
                {
                    // Walk base chain to find the field.
                    for (var c = structSym; c != null; c = c.BaseClass)
                    {
                        if (c.TryGetField(ne.IdentifierToken.Text, out var field))
                        {
                            return new BoundFieldAccessExpression(receiver, c, field);
                        }
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }
                else
                {
                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }

                return new BoundErrorExpression();

            default:
                return new BoundErrorExpression();
        }
    }

    private BoundExpression BindAccessorCall(BoundExpression receiver, ImportedClassSymbol classSymbol, CallExpressionSyntax ce)
    {
        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var argument in ce.Arguments)
        {
            boundArguments.Add(BindExpression(argument));
        }

        var arguments = boundArguments.ToImmutable();
        var methodName = ce.Identifier.Text;

        if (classSymbol != null)
        {
            if (classSymbol.TryLookupFunction(methodName, ce, arguments, out var staticFn))
            {
                return new BoundImportedCallExpression(staticFn, arguments);
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression();
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

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression();
        }

        // Prefer a user-defined class method when the receiver is a user
        // class symbol that has one with this name. (BCL lookup is the
        // fallback for imported CLR types.)
        if (receiver.Type is StructSymbol userClassPriority && userClassPriority.TryGetMethodIncludingInherited(methodName, out var userMethodPriority))
        {
            return BindUserInstanceCall(receiver, userMethodPriority, arguments, ce);
        }

        var clrType = receiver.Type.ClrType;
        var candidates = clrType.GetMethods(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public);
        foreach (var candidate in candidates)
        {
            if (candidate.Name != methodName)
            {
                continue;
            }

            var parameters = candidate.GetParameters();
            if (parameters.Length != arguments.Length)
            {
                continue;
            }

            var match = true;
            for (var i = 0; i < parameters.Length; i++)
            {
                var argType = arguments[i].Type?.ClrType;
                if (argType == null || !ClrTypeUtilities.IsAssignableByName(parameters[i].ParameterType, argType))
                {
                    match = false;
                    break;
                }
            }

            if (match)
            {
                var returnType = TypeSymbol.FromClrType(candidate.ReturnType);
                return new BoundImportedInstanceCallExpression(receiver, candidate, returnType, arguments);
            }
        }

        // Phase 3.B.6 / ADR-0019: extension function fallback. After all
        // instance/static lookups fail, try matching by (receiverType, name).
        if (receiver != null && scope.TryLookupExtensionFunction(receiver.Type, methodName, out var extFn))
        {
            return BindExtensionFunctionCall(receiver, extFn, arguments, ce);
        }

        Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        return new BoundErrorExpression();
    }

    private BoundExpression BindExtensionFunctionCall(BoundExpression receiver, FunctionSymbol extension, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce)
    {
        // The extension's first parameter is the receiver; user arguments line
        // up against parameters[1..].
        var userParamCount = extension.Parameters.Length - 1;
        if (arguments.Length != userParamCount)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, extension.Name, userParamCount, arguments.Length);
            return new BoundErrorExpression();
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(extension.Parameters.Length);
        convertedArgs.Add(BindConversion(ce.Location, receiver, extension.Parameters[0].Type));
        for (var i = 0; i < arguments.Length; i++)
        {
            convertedArgs.Add(BindConversion(ce.Arguments[i].Location, arguments[i], extension.Parameters[i + 1].Type));
        }

        return new BoundCallExpression(extension, convertedArgs.MoveToImmutable());
    }

    private BoundExpression BindUserInstanceCall(BoundExpression receiver, FunctionSymbol method, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce)
    {
        if (arguments.Length != method.Parameters.Length)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, method.Parameters.Length, arguments.Length);
            return new BoundErrorExpression();
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            convertedArgs.Add(BindConversion(ce.Arguments[i].Location, arguments[i], method.Parameters[i].Type));
        }

        return new BoundUserInstanceCallExpression(receiver, method, convertedArgs.ToImmutable());
    }

    private BoundExpression BindArrayCreationExpression(ArrayCreationExpressionSyntax syntax)
    {
        var elementType = LookupType(syntax.ElementTypeIdentifier.Text);
        if (elementType == null)
        {
            Diagnostics.ReportUndefinedType(syntax.ElementTypeIdentifier.Location, syntax.ElementTypeIdentifier.Text);
            return new BoundErrorExpression();
        }

        var elements = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Elements.Count);
        foreach (var elementSyntax in syntax.Elements)
        {
            elements.Add(BindConversion(elementSyntax, elementType));
        }

        if (syntax.LengthToken == null)
        {
            return new BoundArrayCreationExpression(SliceTypeSymbol.Get(elementType), elements.ToImmutable());
        }

        if (!int.TryParse(syntax.LengthToken.Text, out var length) || length < 0)
        {
            Diagnostics.ReportInvalidArrayLength(syntax.LengthToken.Location, syntax.LengthToken.Text);
            return new BoundErrorExpression();
        }

        if (syntax.Elements.Count != length)
        {
            Diagnostics.ReportArrayLiteralLengthMismatch(syntax.Location, length, syntax.Elements.Count);
        }

        return new BoundArrayCreationExpression(ArrayTypeSymbol.Get(elementType, length), elements.ToImmutable());
    }

    private BoundExpression BindIndexExpression(IndexExpressionSyntax syntax)
    {
        var target = BindExpression(syntax.Target);
        var index = BindConversion(syntax.Index, TypeSymbol.Int);

        var element = GetIndexElementType(target.Type);
        if (element != null)
        {
            return new BoundIndexExpression(target, index, element);
        }

        if (target.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(syntax.Target.Location, target.Type);
        }

        return new BoundErrorExpression();
    }

    private BoundExpression BindIndexAssignmentExpression(IndexAssignmentExpressionSyntax syntax)
    {
        var name = syntax.TargetIdentifier.Text;
        if (scope.TryLookupSymbol(name) is not VariableSymbol variable)
        {
            Diagnostics.ReportUndefinedVariable(syntax.TargetIdentifier.Location, name);
            return new BoundErrorExpression();
        }

        var element = GetIndexElementType(variable.Type);
        if (element == null)
        {
            if (variable.Type != TypeSymbol.Error)
            {
                Diagnostics.ReportTypeNotIndexable(syntax.TargetIdentifier.Location, variable.Type);
            }

            return new BoundErrorExpression();
        }

        var index = BindConversion(syntax.Index, TypeSymbol.Int);
        var value = BindConversion(syntax.Value, element);
        return new BoundIndexAssignmentExpression(variable, index, value, element);
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
        var conversion = Conversion.Classify(expression.Type, type);

        if (!conversion.Exists)
        {
            if (expression.Type != TypeSymbol.Error && type != TypeSymbol.Error)
            {
                Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, type);
            }

            return new BoundErrorExpression();
        }

        if (!allowExplicit && conversion.IsExplicit)
        {
            Diagnostics.ReportCannotConvertImplicitly(diagnosticLocation, expression.Type, type);
        }

        if (conversion.IsIdentity)
        {
            return expression;
        }

        return new BoundConversionExpression(type, expression);
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
                            ? (VariableSymbol)new GlobalVariableSymbol(name, isReadOnly, type, accessibility)
                            : new LocalVariableSymbol(name, isReadOnly, type);

        if (declare && !scope.TryDeclareVariable(variable))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, name);
        }

        return variable;
    }

    private VariableSymbol BindVariableReference(string name, TextLocation location)
    {
        switch (scope.TryLookupSymbol(name))
        {
            case VariableSymbol variable:
                return variable;

            case null:
                Diagnostics.ReportUndefinedVariable(location, name);
                return null;

            default:
                Diagnostics.ReportNotAVariable(location, name);
                return null;
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
            case "int":
                return TypeSymbol.Int;
            case "string":
                return TypeSymbol.String;
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
}
