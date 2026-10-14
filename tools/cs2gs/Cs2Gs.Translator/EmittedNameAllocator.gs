// <copyright file="EmittedNameAllocator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import GSharpIdentifierNameContext = GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext
import GSharpSyntaxFacts = GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.Linq
import System.Runtime.CompilerServices
import SystemObject = System.Object

/// Allocates stable, grammar-safe G# names for bound C# symbols.
internal class EmittedNameAllocator {
    private let compilation Compilation
    private let gate object = SystemObject()
    private let emittedNames Dictionary[ISymbol, string] = Dictionary[ISymbol, string](SymbolEqualityComparer.Default)
    private let precomputedContexts Dictionary[ISymbol, GSharpIdentifierNameContext] = Dictionary[
        ISymbol,
        GSharpIdentifierNameContext
    ](SymbolEqualityComparer.Default)
    private let contractGroups Dictionary[ISymbol, IReadOnlyCollection[ISymbol]] = Dictionary[
        ISymbol,
        IReadOnlyCollection[ISymbol]
    ](SymbolEqualityComparer.Default)
    private let methodScopeNames Dictionary[ISymbol, IReadOnlyCollection[string]] = Dictionary[
        ISymbol,
        IReadOnlyCollection[string]
    ](SymbolEqualityComparer.Default)
    private let invocationSensitive HashSet[ISymbol] = HashSet[ISymbol](SymbolEqualityComparer.Default)

    private init(compilation Compilation) {
        this.compilation = compilation
        this.CollectContractGroups()
        this.CollectInvocationSensitiveSymbols()
        this.CollectPrimaryParameterContexts()
    }

    func GetName(
        symbol ISymbol?,
        additionalContext GSharpIdentifierNameContext = GSharpIdentifierNameContext.General
    ) string? {
        var symbol = symbol
        if symbol == nil {
            return nil
        }
        lock this.gate {
            symbol = Canonical(symbol)
            if this.emittedNames.TryGetValue(symbol!!, out var existing) {
                return existing
            }
            let contract = this.GetContractGroup(symbol)
            var context = additionalContext
            for member in contract {
                this.precomputedContexts.TryGetValue(member, out var precomputed)
                context |= this.GetContext(member) | precomputed
            }
            // ADR-0170 / issue #3610: a METADATA-VISIBLE symbol whose name is
            // a G# reserved spelling keeps its exact CLR name via the `$name`
            // escape instead of the lossy `name_` rename — the rename changes
            // the emitted metadata (reflection, InternalsVisibleTo,
            // cross-assembly consumers) and can collide with a legal `name_`
            // neighbor. Locals and other body-scoped names without a CLR
            // metadata slot keep the #3461 rename below, where readability wins.
            let sourceName = SourceName(symbol)
            if contract.Any(IsMetadataVisible) && GSharpSyntaxFacts.IsReservedIdentifier(sourceName, context) {
                let escaped = "$$" + sourceName
                for member in contract {
                    this.emittedNames[member] = escaped
                }
                return escaped
            }
            let emitted = GSharpSyntaxFacts.GetEmittedIdentifier(
                sourceName,
                context,
                contract.SelectMany(this.GetScopeNames).Distinct(StringComparer.Ordinal)
            )
            for member in contract {
                this.emittedNames[member] = emitted
            }
            return emitted
        }
    }

    func GetName(
        name string?,
        context GSharpIdentifierNameContext = GSharpIdentifierNameContext.General,
        scopeNames IEnumerable[string]? = nil
    ) string -> GSharpSyntaxFacts.GetEmittedIdentifier(name!!, context, scopeNames)

    func GetNamespaceName(namespaceSymbol INamespaceSymbol?) string? {
        if namespaceSymbol == nil || namespaceSymbol.IsGlobalNamespace {
            return nil
        }
        let parts = Stack[string]()
        for var current INamespaceSymbol? = namespaceSymbol;
            current != nil &&
            !current.IsGlobalNamespace;
            current = current!!.ContainingNamespace {
            parts.Push(this.GetName(current)!!)
        }
        return string.Join(".", parts)
    }

    private func GetContext(symbol ISymbol) GSharpIdentifierNameContext {
        var context = switch symbol {
            case _ is IParameterSymbol: GSharpIdentifierNameContext.Parameter
            case _ is IRangeVariableSymbol: GSharpIdentifierNameContext.Parameter | GSharpIdentifierNameContext.Local
            case _ is ITypeParameterSymbol: GSharpIdentifierNameContext.TypeParameter | GSharpIdentifierNameContext.Type
            case _ is INamedTypeSymbol: GSharpIdentifierNameContext.Type
            case _ is IAliasSymbol: GSharpIdentifierNameContext.Type
            case iPropertySymbol is IPropertySymbol when iPropertySymbol
                .ContainingType
                .IsAnonymousType == true: GSharpIdentifierNameContext.Parameter
            case property is IPropertySymbol when property.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> reference.GetSyntax() is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParameterSyntax
            ): GSharpIdentifierNameContext.Parameter
            case method is IMethodSymbol when method.Name == "init" &&
                !method
                .DeclaringSyntaxReferences
                .IsDefaultOrEmpty: GSharpIdentifierNameContext.Invocation
            case method is IMethodSymbol when method.MethodKind == MethodKind.LocalFunction: GSharpIdentifierNameContext.Local
            case local is ILocalSymbol when local.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> reference.GetSyntax() is SingleVariableDesignationSyntax
            ): GSharpIdentifierNameContext.Pattern
            case _ is ILocalSymbol: GSharpIdentifierNameContext.Local
            default: GSharpIdentifierNameContext.General
        }
        if !symbol.DeclaringSyntaxReferences.IsDefaultOrEmpty && this.invocationSensitive.Contains(symbol) {
            context |= GSharpIdentifierNameContext.Invocation
        }
        return context
    }

    private func GetScopeNames(symbol ISymbol) IReadOnlyCollection[string] {
        switch symbol {
            case parameter is IParameterSymbol when parameter.ContainingSymbol is IMethodSymbol method {
                var parameterNames = method.Parameters.Select((candidate IParameterSymbol) -> candidate.Name)
                if parameter.ContainingType is {} parameterType {
                    parameterNames = parameterNames.Concat(this.GetVisibleTypeMemberNames(parameterType))
                }
                return parameterNames.Distinct(StringComparer.Ordinal).ToArray()
            }
            case typeParameter is ITypeParameterSymbol when typeParameter.ContainingSymbol is IMethodSymbol method {
                return this
                    .GetVisibleTypeParameterNames(method)
                    .Concat(this.GetLexicallyVisibleTypeNames(typeParameter))
                    .Distinct(StringComparer.Ordinal)
                    .ToArray()
            }
            case typeParameter is ITypeParameterSymbol when typeParameter.ContainingSymbol is INamedTypeSymbol type {
                return this
                    .GetVisibleTypeParameterNames(type)
                    .Concat(this.GetLexicallyVisibleTypeNames(typeParameter))
                    .Distinct(StringComparer.Ordinal)
                    .ToArray()
            }
            case ILocalSymbol {
                return this.GetMethodScopeNames(symbol.ContainingSymbol)
            }
            case IRangeVariableSymbol {
                return this.GetMethodScopeNames(symbol.ContainingSymbol)
            }
            case ILabelSymbol {
                return this.GetMethodScopeNames(symbol.ContainingSymbol)
            }
            case method is IMethodSymbol when method.MethodKind == MethodKind.LocalFunction {
                return this.GetMethodScopeNames(symbol.ContainingSymbol)
            }
            case alias is IAliasSymbol {
                return this.GetAliasScopeNames(alias)
            }
            case namespaceSymbol is INamespaceSymbol {
                return namespaceSymbol
                    .ContainingNamespace
                    ?.GetMembers()
                    .Select(SourceName)
                    .ToArray() ??
                    Array.Empty[string]()
            }
            default {
                return if symbol.ContainingType is {} containingType {
                    this.GetVisibleTypeMemberNames(containingType)
                } else {
                    cast[IReadOnlyCollection[string]](
                        symbol.ContainingNamespace?.GetMembers().Select(SourceName).ToArray() ?? Array.Empty[string]()
                    )
                }
            }
        }
    }

    private func GetVisibleTypeMemberNames(type INamedTypeSymbol) IReadOnlyCollection[string] {
        let names = HashSet[string](type.GetMembers().Select(SourceName), StringComparer.Ordinal)
        for var current INamedTypeSymbol? = type.BaseType; current != nil; current = current!!.BaseType {
            for member in current.GetMembers() {
                if IsVisibleInheritedMember(member, type) {
                    names.Add(SourceName(member))
                }
            }
        }
        for iface in type.AllInterfaces {
            for member in iface.GetMembers() {
                names.Add(SourceName(member))
            }
        }
        return names.ToArray()
    }

    private func GetVisibleTypeParameterNames(symbol ISymbol) IEnumerable[string] {
        let names = HashSet[string](StringComparer.Ordinal)
        for var current ISymbol? = symbol; current != nil; current = current!!.ContainingSymbol {
            switch current {
                case method is IMethodSymbol {
                    names.UnionWith(method.TypeParameters.Select((parameter ITypeParameterSymbol) -> parameter.Name))
                }
                case type is INamedTypeSymbol {
                    names.UnionWith(type.TypeParameters.Select((parameter ITypeParameterSymbol) -> parameter.Name))
                    names.UnionWith(this.GetVisibleNestedTypeNames(type))
                }
            }
        }
        return names
    }

    private func GetVisibleNestedTypeNames(type INamedTypeSymbol) IEnumerable[string] {
        let names = HashSet[string](StringComparer.Ordinal)
        for var current INamedTypeSymbol? = type; current != nil; current = current!!.ContainingType {
            names.UnionWith(current.GetTypeMembers().Select(SourceName))
            for var baseType INamedTypeSymbol? = current.BaseType; baseType != nil; baseType = baseType!!.BaseType {
                for nested in baseType.GetTypeMembers() {
                    if IsVisibleInheritedMember(nested, current) {
                        names.Add(SourceName(nested))
                    }
                }
            }
        }
        return names
    }

    private func GetLexicallyVisibleTypeNames(typeParameter ITypeParameterSymbol) IEnumerable[string] {
        let names = HashSet[string](StringComparer.Ordinal)
        for reference in typeParameter.DeclaringSyntaxReferences {
            let model = this.compilation.GetSemanticModel(reference.SyntaxTree)
            for symbol in model.LookupNamespacesAndTypes(reference.Span.Start) {
                switch symbol {
                    case type is INamedTypeSymbol {
                        names.Add(SourceName(type))
                    }
                    case alias is IAliasSymbol when alias.Target is INamedTypeSymbol {
                        names.Add(alias.Name)
                    }
                }
            }
        }
        return names
    }

    private func GetAliasScopeNames(alias IAliasSymbol) IReadOnlyCollection[string] {
        let reference SyntaxReference? = alias.DeclaringSyntaxReferences.FirstOrDefault()
        if reference == nil {
            return Array.Empty[string]()
        }
        return reference
            .SyntaxTree
            .GetRoot()
            .DescendantNodes()
            .OfType[UsingDirectiveSyntax]()
            .Where((directive UsingDirectiveSyntax) -> directive.Alias != nil)
            .Select((directive UsingDirectiveSyntax) -> directive.Alias!!.Name.Identifier.ValueText)
            .ToArray()
    }

    private func GetMethodScopeNames(containingSymbol ISymbol?) IReadOnlyCollection[string] {
        var method IMethodSymbol? = containingSymbol as IMethodSymbol
        if method == nil {
            return Array.Empty[string]()
        }
        method = method.OriginalDefinition
        if this.methodScopeNames.TryGetValue(method, out var existing) {
            return existing
        }
        let names = HashSet[string](
            method.Parameters.Select((parameter IParameterSymbol) -> parameter.Name),
            StringComparer.Ordinal
        )
        if method.ContainingType is {} containingType {
            names.UnionWith(this.GetVisibleTypeMemberNames(containingType))
        }
        for reference in method.DeclaringSyntaxReferences {
            let root = reference.GetSyntax()
            let model = this.compilation.GetSemanticModel(reference.SyntaxTree)
            for node in root.DescendantNodesAndSelf() {
                let declared ISymbol? = model.GetDeclaredSymbol(node)
                if declared is ILocalSymbol ||
                    declared is IRangeVariableSymbol ||
                    declared is ILabelSymbol ||
                    (
                    declared is IMethodSymbol declaredMethod && declaredMethod.MethodKind == MethodKind.LocalFunction
                ) {
                    if SymbolEqualityComparer.Default.Equals(Canonical(declared!!.ContainingSymbol), method) {
                        names.Add(declared!!.Name)
                    }
                }
            }
        }
        let result = names.ToArray()
        this.methodScopeNames[method] = result
        return result
    }

    private func GetContractGroup(symbol ISymbol?) IReadOnlyCollection[ISymbol] -> if this.contractGroups.TryGetValue(
        symbol!!,
        out var group
    ) {
        group
    } else {
        cast[IReadOnlyCollection[ISymbol]]([]ISymbol{symbol!!})
    }

    private func AddPrecomputedContext(symbol ISymbol?, context GSharpIdentifierNameContext) {
        var symbol = symbol
        symbol = Canonical(symbol)
        this.precomputedContexts.TryGetValue(symbol!!, out var existing)
        this.precomputedContexts[symbol!!] = existing | context
    }

    private func CollectContractGroups() {
        let parent = Dictionary[ISymbol, ISymbol](SymbolEqualityComparer.Default)
        let Find = func (symbol ISymbol?) ISymbol? {
            var symbol = symbol
            symbol = Canonical(symbol)
            if !parent.TryGetValue(symbol!!, out var current) {
                parent[symbol!!] = symbol!!
                return symbol
            }
            if !SymbolEqualityComparer.Default.Equals(current, symbol) {
                parent[symbol!!] = Find(current)!!
            }
            return parent[symbol!!]
        }
        let Union = func (left ISymbol, right ISymbol) {
            let leftRoot ISymbol? = Find(left)
            let rightRoot ISymbol? = Find(right)
            if !SymbolEqualityComparer.Default.Equals(leftRoot, rightRoot) {
                parent[rightRoot!!] = leftRoot!!
            }
        }
        for type in EnumerateSourceTypes(this.compilation.Assembly.GlobalNamespace) {
            for member in type.GetMembers() {
                if member is IPropertySymbol propertyMember {
                    for reference in propertyMember.DeclaringSyntaxReferences {
                        if reference.GetSyntax() is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .ParameterSyntax parameterSyntax &&
                            this
                            .compilation
                            .GetSemanticModel(reference.SyntaxTree)
                            .GetDeclaredSymbol(parameterSyntax) is IParameterSymbol parameter {
                            Union(propertyMember, parameter)
                        }
                    }
                }
                let overridden ISymbol? = switch member {
                    case method is IMethodSymbol: (method.OverriddenMethod as ISymbol)
                    case property is IPropertySymbol: (property.OverriddenProperty as ISymbol)
                    case event is IEventSymbol: (event.OverriddenEvent as ISymbol)
                    default: nil
                }
                if overridden != nil {
                    Union(member, overridden)
                }
                let explicitImplementations IEnumerable[ISymbol] = switch member {
                    case method is IMethodSymbol: method.ExplicitInterfaceImplementations
                    case property is IPropertySymbol: property.ExplicitInterfaceImplementations
                    case event is IEventSymbol: event.ExplicitInterfaceImplementations
                    default: cast[IEnumerable[ISymbol]](Array.Empty[ISymbol]())
                }
                for implemented in explicitImplementations {
                    Union(member, implemented)
                }
            }
            for iface in type.AllInterfaces {
                for interfaceMember in iface.GetMembers() {
                    let implementation ISymbol? = type.FindImplementationForInterfaceMember(interfaceMember)
                    if implementation != nil {
                        Union(implementation, interfaceMember)
                    }
                }
            }
        }
        let groups = Dictionary[ISymbol, List[ISymbol]](SymbolEqualityComparer.Default)
        for symbol in parent.Keys.ToArray() {
            let root ISymbol? = Find(symbol)
            if !groups.TryGetValue(root!!, out var group) {
                group = List[ISymbol]()
                groups[root!!] = group
            }
            group.Add(symbol)
        }
        for group in groups.Values {
            let members = group.ToArray()
            for member in members {
                this.contractGroups[member] = members
            }
        }
    }

    private func CollectPrimaryParameterContexts() {
        for tree in this.compilation.SyntaxTrees {
            let model = this.compilation.GetSemanticModel(tree)
            for record in tree.GetRoot().DescendantNodes().OfType[RecordDeclarationSyntax]() {
                if record.ParameterList != nil {
                    continue
                }
                let instanceConstructors = record
                    .Members
                    .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax]()
                    .Where(
                    (constructor Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax) -> !constructor
                        .Modifiers
                        .Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword)
                )
                    .ToList()
                if instanceConstructors.Count > 0 {
                    if instanceConstructors.Count == 1 && model.GetDeclaredSymbol(record) is INamedTypeSymbol{
                        IsValueType: true
                    } recordStruct {
                        this.CollectRecordStructConstructorContexts(instanceConstructors[0], recordStruct, model)
                    }
                    continue
                }
                let candidates = record
                    .Members
                    .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax]()
                    .Where(
                    (property Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax) -> !property
                        .Modifiers
                        .Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword) &&
                        property.ExpressionBody == nil &&
                        property.AccessorList != nil &&
                        property.AccessorList!!
                        .Accessors
                        .All(
                        (accessor AccessorDeclarationSyntax) -> accessor.Body == nil && accessor.ExpressionBody == nil
                    ) &&
                        property.AccessorList!!
                        .Accessors
                        .Any(
                        (accessor AccessorDeclarationSyntax) -> accessor.IsKind(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration
                        )
                    )
                )
                    .Select(
                    (property Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax) -> (
                        Syntax: property,
                        Symbol: model.GetDeclaredSymbol(property) as IPropertySymbol
                    )
                )
                    .Where(
                    (
                        candidate(
                            Syntax Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax,
                            Symbol IPropertySymbol
                        )
                    ) -> candidate.Item2 != nil
                )
                    .ToList()
                if candidates.Count == 0 || candidates.Any(
                    (
                        candidate(
                            Syntax Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax,
                            Symbol IPropertySymbol
                        )
                    ) -> this
                        .GetContractGroup(Canonical(candidate.Item2)).Count > 1
                ) {
                    continue
                }
                var abort = false
                let parameters = List[IPropertySymbol]()
                for candidate in candidates {
                    let property IPropertySymbol? = candidate.Item2
                    if property!!.IsRequired || property!!.SetMethod?.IsInitOnly == true {
                        continue
                    }
                    let nonConstantInitializer = candidate.Item1.Initializer != nil && !model.GetConstantValue(
                        candidate.Item1.Initializer!!.Value
                    )
                        .HasValue
                    if nonConstantInitializer {
                        if property!!.ContainingType.IsValueType {
                            abort = true
                            break
                        }
                        continue
                    }
                    parameters.Add(property!!)
                }
                if !abort {
                    for property in parameters {
                        this.AddPrecomputedContext(property, GSharpIdentifierNameContext.Parameter)
                    }
                }
            }
        }
    }

    private func CollectRecordStructConstructorContexts(
        constructor Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax,
        containingType INamedTypeSymbol,
        model SemanticModel
    ) {
        if constructor.Body == nil || constructor.Initializer != nil || model.GetDeclaredSymbol(
            constructor
        ) is not IMethodSymbol constructorSymbol {
            return
        }
        let targets = Dictionary[IParameterSymbol, ISymbol](SymbolEqualityComparer.Default)
        for statement in constructor.Body!!.Statements {
            if !(
                statement is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ExpressionStatementSyntax{
                    Expression: Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax assignment
                }
            ) ||
                !assignment
                .OperatorToken
                .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.EqualsToken) || model.GetSymbolInfo(assignment.Left)
                .Symbol is not ISymbol target ||
                !(target is IFieldSymbol) &&
                !(target is IPropertySymbol) ||
                target.IsStatic ||
                !SymbolEqualityComparer
                .Default
                .Equals(target.ContainingType, containingType) ||
                assignment.Right is not IdentifierNameSyntax right ||
                model
                .GetSymbolInfo(right)
                .Symbol is not IParameterSymbol parameter ||
                !SymbolEqualityComparer
                .Default
                .Equals(parameter.ContainingSymbol, constructorSymbol) || !targets.TryAdd(parameter, target) {
                return
            }
        }
        if constructorSymbol.Parameters.Any((parameter IParameterSymbol) -> !targets.ContainsKey(parameter)) {
            return
        }
        for target in targets.Values {
            this.AddPrecomputedContext(target, GSharpIdentifierNameContext.Parameter)
        }
    }

    private func CollectInvocationSensitiveSymbols() {
        for tree in this.compilation.SyntaxTrees {
            let model = this.compilation.GetSemanticModel(tree)
            let root = tree.GetRoot()
            for invocation in root.DescendantNodes().OfType[InvocationExpressionSyntax]() {
                if invocation.Expression is not SimpleNameSyntax simple || model.GetSymbolInfo(simple)
                    .Symbol is not{} symbol {
                    continue
                }
                if GSharpSyntaxFacts.IsReservedIdentifier(
                    simple.Identifier.ValueText,
                    GSharpIdentifierNameContext.Invocation
                ) {
                    this.invocationSensitive.Add(Canonical(symbol)!!)
                }
                if simple is GenericNameSyntax &&
                    !symbol
                    .DeclaringSyntaxReferences
                    .IsDefaultOrEmpty &&
                    GSharpSyntaxFacts
                    .IsReservedIdentifier(simple.Identifier.ValueText, GSharpIdentifierNameContext.Index) {
                    this.AddPrecomputedContext(symbol, GSharpIdentifierNameContext.Index)
                }
            }
            for creation in root.DescendantNodes()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ObjectCreationExpressionSyntax]() {
                if model.GetSymbolInfo(creation).Symbol is not IMethodSymbol constructor {
                    continue
                }
                let name = RightmostIdentifier(creation.Type)
                if GSharpSyntaxFacts.IsReservedIdentifier(name, GSharpIdentifierNameContext.Invocation) {
                    this.invocationSensitive.Add(Canonical(constructor.ContainingType)!!)
                }
                if HasGenericRightmostName(creation.Type) && GSharpSyntaxFacts.IsReservedIdentifier(
                    name,
                    GSharpIdentifierNameContext.Index
                ) {
                    this.AddPrecomputedContext(constructor.ContainingType, GSharpIdentifierNameContext.Index)
                }
            }
            for creation in root.DescendantNodes().OfType[ImplicitObjectCreationExpressionSyntax]() {
                if model.GetTypeInfo(creation).Type is INamedTypeSymbol type && GSharpSyntaxFacts.IsReservedIdentifier(
                    type.Name,
                    GSharpIdentifierNameContext.Invocation
                ) {
                    this.invocationSensitive.Add(Canonical(type)!!)
                }
                if model.GetTypeInfo(creation)
                    .Type is INamedTypeSymbol{IsGenericType: true} genericType &&
                    GSharpSyntaxFacts
                    .IsReservedIdentifier(genericType.Name, GSharpIdentifierNameContext.Index) {
                    this.AddPrecomputedContext(genericType, GSharpIdentifierNameContext.Index)
                }
            }
            for access in root.DescendantNodes().OfType[ElementAccessExpressionSyntax]() {
                if access.Expression is IdentifierNameSyntax identifier && GSharpSyntaxFacts.IsReservedIdentifier(
                    identifier.Identifier.ValueText,
                    GSharpIdentifierNameContext.Index
                ) &&
                    model
                    .GetSymbolInfo(identifier)
                    .Symbol is {} symbol &&
                    !symbol
                    .DeclaringSyntaxReferences
                    .IsDefaultOrEmpty {
                    this.AddPrecomputedContext(symbol, GSharpIdentifierNameContext.Index)
                }
            }
        }
    }

    shared {
        private let Cache ConditionalWeakTable[Compilation, EmittedNameAllocator] = ConditionalWeakTable[
            Compilation,
            EmittedNameAllocator
        ]()
        func For(compilation Compilation) EmittedNameAllocator -> Cache.GetValue(
            compilation,
            (value Compilation) -> EmittedNameAllocator(value)
        )

        // ADR-0170: symbols whose emitted names ARE their CLR metadata names —
        // namespaces, named types, type members, parameters, and type parameters.
        // Parameter names are emitted even when their containing member is private.
        // Locals, range variables, local/anonymous functions, and synthesized
        // shapes (anonymous-type members, aliases, discards) stay on the rename path.
        private func IsMetadataVisible(symbol ISymbol) bool -> switch symbol {
            case _ is INamespaceSymbol: true
            case iNamedTypeSymbol is INamedTypeSymbol when iNamedTypeSymbol.IsAnonymousType == false: true
            case _ is IParameterSymbol: true
            case _ is ITypeParameterSymbol: true
            case method is IMethodSymbol when method.MethodKind == MethodKind.LocalFunction ||
                method.MethodKind == MethodKind.AnonymousFunction: false
            case method is IMethodSymbol: method.ContainingType?.IsAnonymousType == false
            case property is IPropertySymbol: property.ContainingType?.IsAnonymousType == false
            case field is IFieldSymbol: field.ContainingType?.IsAnonymousType == false
            case _ is IEventSymbol: true
            default: false
        }

        private func Canonical(symbol ISymbol?) ISymbol? -> switch symbol {
            case method is IMethodSymbol: cast[ISymbol](method.OriginalDefinition)
            case property is IPropertySymbol: cast[ISymbol](property.OriginalDefinition)
            case event is IEventSymbol: cast[ISymbol](event.OriginalDefinition)
            case type is INamedTypeSymbol: cast[ISymbol](type.OriginalDefinition)
            default: symbol
        }

        private func SourceName(symbol ISymbol?) string {
            let separator = symbol!!.Name.LastIndexOf('.')
            return if separator >= 0 {
                symbol!!.Name.Substring(separator + 1)
            } else {
                symbol!!.Name
            }
        }

        private func IsVisibleInheritedMember(member ISymbol, derivedType INamedTypeSymbol) bool -> switch member
            .DeclaredAccessibility {
            case Accessibility.Public or Accessibility.Protected or Accessibility.ProtectedOrInternal: true
            case Accessibility.Internal or Accessibility.ProtectedAndInternal: SymbolEqualityComparer.Default.Equals(
                member.ContainingAssembly,
                derivedType.ContainingAssembly
            ) ||
                member
                .ContainingAssembly
                ?.GivesAccessTo(derivedType.ContainingAssembly!!) == true
            default: false
        }

        private func EnumerateSourceTypes(namespaceSymbol INamespaceSymbol) sequence[INamedTypeSymbol] {
            for type in namespaceSymbol.GetTypeMembers() {
                yield type
                for nested in EnumerateNestedTypes(type) {
                    yield nested
                }
            }
            for child in namespaceSymbol.GetNamespaceMembers() {
                for type in EnumerateSourceTypes(child) {
                    yield type
                }
            }
        }

        private func EnumerateNestedTypes(type INamedTypeSymbol) sequence[INamedTypeSymbol] {
            for nested in type.GetTypeMembers() {
                yield nested
                for deeper in EnumerateNestedTypes(nested) {
                    yield deeper
                }
            }
        }

        private func RightmostIdentifier(type TypeSyntax) string -> switch type {
            case simple is SimpleNameSyntax: simple.Identifier.ValueText
            case qualified is QualifiedNameSyntax: qualified.Right.Identifier.ValueText
            case alias is AliasQualifiedNameSyntax: alias.Name.Identifier.ValueText
            default: type.ToString()
        }

        private func HasGenericRightmostName(type TypeSyntax) bool -> switch type {
            case _ is GenericNameSyntax: true
            case qualified is QualifiedNameSyntax: qualified.Right is GenericNameSyntax
            case alias is AliasQualifiedNameSyntax: alias.Name is GenericNameSyntax
            default: false
        }
    }
}
