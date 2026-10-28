// <copyright file="SemanticModel.Members.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Threading

/// Member queries of (cref:SemanticModel) (ADR-0212 section 7b, slice S4).
partial class SemanticModel {
    /// Returns the members of [`type`](paramref) that a member access at [`position`](paramref) can name,
    /// instance and static, as symbols.
    /// @remarks Contract, one row per receiver type. `T?` and `T!` first answer for `T`.
    /// <list type="table">
    /// <item>Tuple: the declared element names, then the positional `ItemN` names, as fields in element order.</item>
    /// <item>Struct or class, declared or imported record: fields, properties, events and methods of the type
    /// and of its base classes, base classes last (instance members), then the static members of the type
    /// itself. A static member of a base class is not a member of the derived type.</item>
    /// <item>Struct or class, then (issue #5441): the public instance members of the nearest imported base class
    /// (reached through source base classes), or of `object` when there is none, read at that base, in
    /// metadata order. A static or non-public member of the base is not listed. A member that the type
    /// or a source base overrides is not listed: the override stands for the slot.</item>
    /// <item>Struct or class, then (issue #5441): each default method of an interface the type or one of its
    /// base classes implements, interfaces in declaration order and their base interfaces after them, when
    /// neither the type nor a base class declares a method of that name (the rule of the call binder). A
    /// private helper is listed only where the enclosing declaration may access it.</item>
    /// <item>Interface: the properties, events and methods of the interface and of its base interfaces
    /// (instance), the static members of the interface itself, then the members of each CLR interface the
    /// declared interfaces extend, nearest first.</item>
    /// <item>Enum: the enum members, which are static.</item>
    /// <item>Any other type that has a CLR type (imported types, arrays, maps, primitives): the public
    /// properties without index parameters, fields, methods that are not special names, then events, each in
    /// metadata order; instance and static members; types read through the ADR-0193 readers at the
    /// receiver. For an interface, the members of the CLR interfaces it extends follow its own (issue #5441),
    /// each in the same order, in the order of the guarded transitive interface list (cref:ClrTypeUtilities.SafeGetInterfaces).</item>
    /// <item>A slice, array, map, channel or sequence with no CLR type, because its element is a source type
    /// or a type parameter (issue #5441): the members of the type the call binder uses for the receiver
    /// (`System.Array`, `Dictionary`, `Channel`, `ChannelReader`, `ChannelWriter`, `IEnumerable`), with member
    /// types read at the receiver's type arguments. The list is the one the same collection of a primitive
    /// has, extensions aside.</item>
    /// </list>
    /// A member that is private or protected is returned only when the enclosing declaration of
    /// [`position`](paramref) may access it. Imported members are public ones. With [`name`](paramref), only
    /// members of that name: a method name returns every overload, in declaration order.
    /// Extension members (ADR-0212 question 12), last and for every receiver type that is not an error:
    /// <list type="table">
    /// <item>Extension function declared in source: each one in scope whose receiver type can take the
    /// receiver, found by the rule a call by that name uses, as the function symbol. Order: file path
    /// (ordinal), then start position.</item>
    /// <item>Extension method of an imported class: each `static [Extension]` method of the classes in the
    /// namespaces the file imports whose first parameter can take the receiver, by the rule of the call
    /// binder, as an imported function symbol whose parameters include the receiver. A receiver with no CLR
    /// shape (a declared class) is probed as its imported base class, and through the interface it implements
    /// when it has none or the base is `object`. Order: the
    /// holder classes in reference order, then metadata order. Generic methods keep their open signature.</item>
    /// </list>
    /// An extension is listed even where a member of the same name hides it at a call, and the receiver
    /// of a static access (a type name) gets the same extensions as an instance.
    /// @param position A character offset into this model's tree.
    /// @param type The receiver type.
    /// @param name When given, only the members of this name.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The members in the order of the table, empty when none matches.
    func LookupMembers(
        position int32,
        type TypeSymbol,
        name string? = nil,
        cancellationToken CancellationToken = default(CancellationToken)
    ) ImmutableArray[Symbol] {
        cancellationToken.ThrowIfCancellationRequested()
        index.Get(cancellationToken)
        let result = ImmutableArray.CreateBuilder[Symbol]()
        let receiver = UnwrapNullability(type)
        let access = MemberAccessContext(GetEnclosingSymbol(position, cancellationToken))
        switch receiver {
            case tuple is TupleTypeSymbol {
                AddTupleMembers(tuple, name, result)
            }
            case structure is StructSymbol {
                AddSourceMembers(
                    structure,
                    MemberQuery.Instance(MemberKinds.All),
                    MemberQuery.Static(MemberKinds.All),
                    name,
                    access,
                    result
                )
                // A CLR-backed aggregate (an imported record) already holds the members it inherits.
                if structure.ClrType == nil {
                    AddImportedBaseMembers(structure, name, result)
                }
                AddDefaultInterfaceMethods(structure, name, access, result)
            }
            case declared is InterfaceSymbol {
                AddSourceMembers(
                    declared,
                    MemberQuery.Instance(MemberKinds.Property | MemberKinds.Event | MemberKinds.Method),
                    MemberQuery.Static(MemberKinds.Property | MemberKinds.Method),
                    name,
                    access,
                    result
                )
                for clrInterface in ClrTypeUtilities.GetTransitiveClrBaseInterfaces(declared) {
                    // The walk is already transitive, so each interface contributes only its own members.
                    AddClrMembersOf(
                        ImportedTypeSymbol.GetWithoutNullability(clrInterface, NullabilityFreeReason.TypeStructure),
                        clrInterface,
                        BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static,
                        name,
                        result
                    )
                }
            }
            case enumeration is EnumSymbol {
                AddSourceMembers(
                    enumeration,
                    MemberQuery.Instance(MemberKinds.Field),
                    MemberQuery.Static(MemberKinds.Field),
                    name,
                    access,
                    result
                )
            }
            default {
                if receiver.ClrType is {} clrType {
                    AddClrMembers(receiver, clrType, name, result)
                } else if BuiltInView(receiver) is {} view && view.ClrType is {} viewClrType {
                    AddClrMembers(view, viewClrType, name, result)
                }
            }
        }
        AddExtensionMembers(position, receiver, name, cancellationToken, result)
        return result.ToImmutable()
    }

    /// Adds the public instance members that a source class or struct inherits from its imported base class,
    /// and from `object` when it has none, read at that base. A class reaches metadata through its nearest
    /// imported base (cref:ExpressionBinder.GetInheritedClrBaseType), the rule the binder uses to bind an
    /// inherited member.
    private func AddImportedBaseMembers(structure StructSymbol, name string?, result ImmutableArray[Symbol].Builder) {
        var baseType TypeSymbol? = nil
        for current in structure.GetHierarchy() {
            if current.ImportedBaseType is {} imported {
                baseType = imported
                break
            }
        }
        let overridden = ExternalOverrides(structure)
        if baseType == nil {
            AddClrMembers(
                ImportedTypeSymbol.GetWithoutNullability(typeof(object), NullabilityFreeReason.TypeStructure),
                typeof(object),
                name,
                result,
                includeStatic: false,
                overridden
            )
        } else if baseType.ClrType is {} baseClr {
            AddClrMembers(baseType, baseClr, name, result, includeStatic: false, overridden)
        }
    }

    /// Returns the imported slots that the source members of [`structure`](paramref) and of its source bases
    /// override. The override stands for the slot: the imported member is not listed again.
    private func ExternalOverrides(structure StructSymbol) ImportedOverrides {
        let overridden = ImportedOverrides()
        for member in TypeMemberModel.EnumerateMembers(structure, MemberQuery.Instance(MemberKinds.All)) {
            switch member {
                case function is FunctionSymbol {
                    if function.ExternalOverriddenMethod != nil {
                        overridden.AddSlot(function.ExternalOverriddenMethod)
                    } else if function.IsOverride && function.OverriddenMethod == nil {
                        // A compiler-owned override (the equality methods of a data type) names no slot.
                        overridden.AddUnrecorded(function)
                    }
                }
                case property is PropertySymbol {
                    overridden.AddSlot(property.ExternalOverriddenGetter)
                    overridden.AddSlot(property.ExternalOverriddenSetter)
                }
                case clrEvent is EventSymbol {
                    overridden.AddSlot(clrEvent.ExternalOverriddenAddMethod)
                    overridden.AddSlot(clrEvent.ExternalOverriddenRemoveMethod)
                    overridden.AddSlot(clrEvent.ExternalOverriddenRaiseMethod)
                }
            }
        }
        return overridden
    }

    /// The imported methods that source members override: by the slot the binder recorded, or, for an override
    /// the compiler synthesized, by name and parameter types.
    private class ImportedOverrides {
        private let slots List[MethodInfo] = List[MethodInfo]()
        private let unrecorded List[FunctionSymbol] = List[FunctionSymbol]()

        func AddSlot(method MethodInfo?) {
            if method != nil {
                slots.Add(method)
            }
        }

        func AddUnrecorded(function FunctionSymbol) {
            unrecorded.Add(function)
        }

        // The same slot: a reflected method is a different object per reflected type, its token and module are not.
        func Covers(accessor MethodInfo?) bool {
            if accessor == nil {
                return false
            }
            return slots.Any(
                (o MethodInfo) -> o.MetadataToken == accessor.MetadataToken && string.Equals(
                    o.Module.Name,
                    accessor.Module.Name,
                    StringComparison.Ordinal
                )
            ) ||
                unrecorded.Any((f FunctionSymbol) -> Overrides(f, accessor))
        }

        private func Overrides(function FunctionSymbol, method MethodInfo) bool {
            if !ClrTypeUtilities.EmittedMemberNameMatches(method, function.Name) {
                return false
            }
            let parameters = method.GetParameters()
            if parameters.Length != function.Parameters.Length {
                return false
            }
            for var i = 0; i < parameters.Length; i++ {
                if function.Parameters[i].Type.ClrType is not{} sourceType || !ClrTypeInspector.IsSameAs(
                    sourceType,
                    parameters[i].ParameterType
                ) {
                    return false
                }
            }
            return true
        }
    }

    /// Adds the default methods of the interfaces that a class or struct implements, the ones it does not
    /// declare a method of the same name for. The binder routes a call on the class to such a method
    /// (`TryFindDefaultInterfaceMethod`); only the order is set here: classes of the hierarchy from the
    /// receiver up, interfaces in declaration order.
    private func AddDefaultInterfaceMethods(
        structure StructSymbol,
        name string?,
        access MemberAccessContext,
        result ImmutableArray[Symbol].Builder
    ) {
        let seen = List[Symbol]()
        for current in structure.GetHierarchy() {
            for declared in current.Interfaces {
                if declared == nil {
                    continue
                }
                for member in TypeMemberModel.EnumerateMembers(declared, MemberQuery.Instance(MemberKinds.Method)) {
                    if member is FunctionSymbol method && InterfaceSymbol.HasDefaultBody(method) && !seen.Contains(
                        method
                    ) &&
                        MemberLookup
                        .CollectSourceInstanceMethods(structure, method.Name).IsEmpty {
                        seen.Add(method)
                        AddSourceMember(structure, method, name, access, result)
                    }
                }
            }
        }
    }

    /// Returns the type whose CLR members a receiver without a loadable CLR type has: the view that the call
    /// binder gives it (cref:ExpressionBinder.TryNormalizeSymbolicEnumerableReceiver), so the query and the
    /// binder agree on `.Length` of a slice of a source class, `.Count` of a map of one, a channel and a
    /// sequence.
    private func BuiltInView(receiver TypeSymbol) ImportedTypeSymbol? {
        if receiver.ClrType == nil && ExpressionBinder.TryNormalizeSymbolicEnumerableReceiver(receiver, out var view) {
            return view as ImportedTypeSymbol
        }
        return nil
    }

    /// Adds the extension functions and extension methods in scope at [`position`](paramref) whose receiver
    /// can take [`receiver`](paramref). The applicability rules are the binder's (see
    /// `Binder.CollectExtensionMembers`); only the order is set here.
    private func AddExtensionMembers(
        position int32,
        receiver TypeSymbol,
        name string?,
        cancellationToken CancellationToken,
        result ImmutableArray[Symbol].Builder
    ) {
        if object.ReferenceEquals(receiver, TypeSymbol.Error) || receiver == TypeSymbol.Void {
            return
        }
        let function FunctionSymbol? = switch GetEnclosingSymbol(position, cancellationToken) {
            case enclosing is FunctionSymbol: enclosing
            case property is PropertySymbol: property.GetterSymbol ?? property.SetterSymbol
            default: default(FunctionSymbol?)
        }
        using let nullabilityScope = NullabilityOptions.Enter(compilation.Nullability, compilation.PlatformNilChecks)
        let found = Binder.CollectExtensionMembers(
            compilation.GlobalScope,
            compilation.References ?? ReferenceResolver.Default(),
            function,
            receiver,
            name,
            syntaxTree,
            compilation.Submission?.DefaultPackageName ?? "Default"
        )
        // Declared extensions by file path (ordinal), then start, so the order does not depend on the order
        // files were bound in. Imported ones keep holder order, then metadata order.
        let declared = found
            .Source
            .Select(
            (f FunctionSymbol) -> (
                Function: f,
                File: f.Declaration?.SyntaxTree.Text?.FileName ?? string.Empty,
                Start: f.Declaration?.Span.Start ?? int32.MaxValue
            )
        )
            .OrderBy((e(Function FunctionSymbol, File string, Start int32)) -> e.File, StringComparer.Ordinal)
            .ThenBy((e(Function FunctionSymbol, File string, Start int32)) -> e.Start)
        for entry in declared {
            result.Add(entry.Function)
        }
        for method in found.Imported {
            result.Add(ImportedMemberSymbol(default(TypeSymbol?), method))
        }
    }

    /// Returns the candidates the call or the member name at [`node`](paramref) resolved among, from the
    /// candidate sets that overload resolution recorded on the bound call (ADR-0212 slice S4). Nothing is
    /// looked up again after binding.
    /// @remarks Contract, one row per shape of call. A call that had one candidate, a property, a field or an
    /// event answers that symbol alone.
    /// <list type="table">
    /// <item>Imported function or method: the reflected overloads the resolver held, as imported function
    /// symbols; derived type first, then its bases; within a type by metadata token.</item>
    /// <item>Local function: the function alone (a lexical group has one member).</item>
    /// <item>Free source function: the functions of that name in the package, by file path (ordinal), then
    /// by start position.</item>
    /// <item>Method of a class or struct: the methods of that name declared by the receiver's type, then
    /// those of its base classes, and a call through a constructed base or interface keeps the declaring
    /// type's signatures.</item>
    /// <item>Interface method: the methods of that name of the interface and of its base interfaces; the
    /// private helpers only for a query inside the interface.</item>
    /// <item>Type parameter with constraints: the methods of that name of each constraint, in constraint
    /// order.</item>
    /// <item>Partial type: the methods of every part, by file path (ordinal), then by start position.</item>
    /// </list>
    /// Constructor calls and extension methods dispatched as instance calls are not in the contract.
    /// The compilation must have (cref:Compilation.RecordMemberGroups) set before its first query; a
    /// compilation without it answers an empty array for every node.
    /// @param node A call expression, the name of a call or member access, or its identifier token.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The candidates, empty when the node names no call or member.
    func GetMemberGroup(
        node SyntaxNode,
        cancellationToken CancellationToken = default(CancellationToken)
    ) ImmutableArray[Symbol] {
        cancellationToken.ThrowIfCancellationRequested()
        index.Get(cancellationToken)
        // Without recording the candidates are unknown, and a group of the selected callee alone would
        // look complete. The query answers nothing instead.
        if !compilation.RecordMemberGroups {
            return ImmutableArray[Symbol].Empty
        }
        let token = MemberGroupToken(node)
        if token == nil || token.Kind != SyntaxKind.IdentifierToken || token.IsMissing || !object.ReferenceEquals(
            token.SyntaxTree,
            syntaxTree
        ) {
            return ImmutableArray[Symbol].Empty
        }
        let referenced = Unwrap(FindReferencedNode(token))
        if referenced is BoundCallOperationExpression call && !call.MemberGroup.IsDefaultOrEmpty {
            if !SpellsName(call.CalledFunction, token.ValueText) {
                return ImmutableArray[Symbol].Empty
            }
            let receiverType TypeSymbol? = switch call {
                case instanceCall is BoundImportedInstanceCallExpression: instanceCall.Receiver.Type
                case importedCall is BoundImportedCallExpression: importedCall.StaticContainerType
                default: default(TypeSymbol?)
            }
            let group = ImmutableArray.CreateBuilder[Symbol]()
            for candidate in call.MemberGroup {
                switch candidate {
                    case function is FunctionSymbol {
                        group.Add(function)
                    }
                    case method is MethodInfo {
                        group.Add(ImportedMemberSymbol(receiverType, method))
                    }
                }
            }
            return OrderMemberGroup(group.ToImmutable())
        }
        let single = GetTokenSymbol(token)
        // A call through a local function value names a variable; any other variable or type is no member.
        let calledVariable = single is VariableSymbol && token.Parent is CallExpressionSyntax{Callee: nil}
        return if single == nil ||
            (
            !calledVariable &&
                single is not(
                FunctionSymbol or
                    ImportedFunctionSymbol or
                    PropertySymbol or
                    FieldSymbol or
                    EventSymbol or
                    EnumMemberSymbol
            )
        ) {
            ImmutableArray[Symbol].Empty
        } else {
            ImmutableArray.Create(single)
        }
    }

    // An imported member can differ from its G# spelling (`@return` in metadata is `return_`).
    private func SpellsName(symbol Symbol, name string) bool {
        let member MemberInfo? = switch symbol {
            case function is ImportedFunctionSymbol: function.Method
            case property is PropertySymbol: property.ImportedMember
            case field is FieldSymbol: field.ImportedMember
            case clrEvent is EventSymbol: clrEvent.ImportedMember
            default: default(MemberInfo?)
        }
        return if member != nil {
            ClrTypeUtilities.EmittedMemberNameMatches(member, name)
        } else {
            symbol.Name == name
        }
    }

    private func MemberGroupToken(node SyntaxNode) SyntaxToken? {
        var current SyntaxNode = node
        for var depth = 0; depth < 32; depth++ {
            switch current {
                case token is SyntaxToken {
                    return token
                }
                case call is CallExpressionSyntax {
                    return call.Identifier
                }
                case name is NameExpressionSyntax {
                    return name.IdentifierToken
                }
                case accessor is AccessorExpressionSyntax {
                    current = accessor.RightPart
                }
                case parenthesized is ParenthesizedExpressionSyntax {
                    current = parenthesized.Expression
                }
                default {
                    return nil
                }
            }
        }
        return nil
    }

    // Owners keep the order in which the resolver met them (derived first). Within an owner, imported
    // methods follow metadata order and source functions follow their file path (ordinal) and start, so
    // a partial type or a package's free functions do not depend on the order files were bound in.
    private func OrderMemberGroup(group ImmutableArray[Symbol]) ImmutableArray[Symbol] {
        let owners = List[object]()
        let ordered = List[(Symbol Symbol, Owner int32, File string, Start int32)]()
        for member in group {
            let ownerKey = OwnerKeyOf(member)
            var owner = owners.FindIndex((o object) -> object.Equals(o, ownerKey))
            if owner < 0 {
                owner = owners.Count
                owners.Add(ownerKey)
            }
            if member is ImportedFunctionSymbol imported {
                ordered.Add((member, owner, string.Empty, imported.Method.MetadataToken))
            } else if member is FunctionSymbol{Declaration: {} declaration} {
                ordered.Add(
                    (member, owner, declaration.SyntaxTree.Text?.FileName ?? string.Empty, declaration.Span.Start)
                )
            } else {
                ordered.Add((member, owner, string.Empty, int32.MaxValue))
            }
        }
        return ordered
            .OrderBy((e(Symbol Symbol, Owner int32, File string, Start int32)) -> e.Owner)
            .ThenBy((e(Symbol Symbol, Owner int32, File string, Start int32)) -> e.File, StringComparer.Ordinal)
            .ThenBy((e(Symbol Symbol, Owner int32, File string, Start int32)) -> e.Start)
            .Select((e(Symbol Symbol, Owner int32, File string, Start int32)) -> e.Symbol)
            .ToImmutableArray()
    }

    // An owner is a type, not a name: `A.D` and `B.D` are two owners. A constructed type keeps its definition.
    private func OwnerKeyOf(member Symbol) object -> switch member {
        case imported is ImportedFunctionSymbol: cast[object](imported.Method.DeclaringType)
        case function is FunctionSymbol: OwnerOf(function)
        default: cast[object](member)
    }

    private func OwnerOf(function FunctionSymbol) object {
        let owner TypeSymbol? = function.ReceiverType ?? function.StaticOwnerType
        if owner is StructSymbol structure {
            return structure.Definition ?? structure
        }
        if owner is InterfaceSymbol declared {
            return declared.Definition ?? declared
        }
        if owner != nil {
            return owner
        }
        return function.Package ?? cast[object](function)
    }

    private func UnwrapNullability(type TypeSymbol) TypeSymbol {
        var current = type
        for var depth = 0; depth < 8; depth++ {
            if current is NullableTypeSymbol nullable {
                current = nullable.UnderlyingType
            } else if current is PlatformTypeSymbol platform {
                current = platform.UnderlyingType
            } else {
                break
            }
        }
        return current
    }

    private func AddTupleMembers(tuple TupleTypeSymbol, name string?, result ImmutableArray[Symbol].Builder) {
        for var i = 0; i < tuple.Arity; i++ {
            if tuple.HasNames && tuple.ElementNames[i] is {} elementName && (name == nil || name == elementName) {
                result.Add(TupleField(tuple, elementName, tuple.ElementTypes[i]))
            }
            let positional = "Item" + (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture)
            if name == nil || name == positional {
                result.Add(TupleField(tuple, positional, tuple.ElementTypes[i]))
            }
        }
    }

    private func TupleField(tuple TupleTypeSymbol, fieldName string, elementType TypeSymbol) FieldSymbol {
        let field = FieldSymbol(fieldName, elementType, Accessibility.Public, isReadOnly: false)
        field.AnchorContainingType(tuple)
        return field
    }

    private func AddSourceMembers(
        type TypeSymbol,
        instance MemberQuery,
        static MemberQuery,
        name string?,
        access MemberAccessContext,
        result ImmutableArray[Symbol].Builder
    ) {
        for member in TypeMemberModel.EnumerateMembers(type, instance) {
            AddSourceMember(type, member, name, access, result)
        }
        for member in TypeMemberModel.EnumerateMembers(type, static) {
            AddSourceMember(type, member, name, access, result)
        }
    }

    private func AddSourceMember(
        receiver TypeSymbol,
        member Symbol,
        name string?,
        access MemberAccessContext,
        result ImmutableArray[Symbol].Builder
    ) {
        if name != nil && member.Name != name {
            return
        }
        if !access.CanAccess(member, receiver) {
            return
        }
        result.Add(member)
    }

    private func AddClrMembers(
        receiver TypeSymbol,
        clrType Type,
        name string?,
        result ImmutableArray[Symbol].Builder,
        includeStatic bool = true,
        overridden ImportedOverrides? = nil
    ) {
        let flags = if includeStatic {
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static
        } else {
            BindingFlags.Public | BindingFlags.Instance
        }
        AddClrMembersOf(receiver, clrType, flags, name, result, overridden)
        // An interface does not report the members of the interfaces it extends; they are its members too.
        if clrType.IsInterface {
            // The guarded, transitive walk: a missing reference assembly or a load context that reports only
            // the direct interfaces does not fail the query.
            for baseInterface in ClrTypeUtilities.SafeGetInterfaces(clrType) {
                AddClrMembersOf(receiver, baseInterface, flags, name, result, overridden)
            }
        }
    }

    private func AddClrMembersOf(
        receiver TypeSymbol,
        clrType Type,
        flags BindingFlags,
        name string?,
        result ImmutableArray[Symbol].Builder,
        overridden ImportedOverrides? = nil
    ) {
        for property in ClrTypeUtilities.SafeGetProperties(clrType, flags) {
            if property.GetIndexParameters()
                .Length == 0 &&
                (name == nil || ClrTypeUtilities.EmittedMemberNameMatches(property, name)) &&
                !(overridden?.Covers(property.GetMethod) ?? false) &&
                !(overridden?.Covers(property.SetMethod) ?? false) {
                result.Add(ImportedMemberSymbol(receiver, property))
            }
        }
        for field in ClrTypeUtilities.SafeGetFields(clrType, flags) {
            if name == nil || ClrTypeUtilities.EmittedMemberNameMatches(field, name) {
                result.Add(ImportedMemberSymbol(receiver, field))
            }
        }
        for method in ClrTypeUtilities.SafeGetMethods(clrType, flags) {
            if !method.IsSpecialName &&
                (name == nil || ClrTypeUtilities.EmittedMemberNameMatches(method, name)) &&
                !(overridden?.Covers(method) ?? false) {
                result.Add(ImportedMemberSymbol(receiver, method))
            }
        }
        for clrEvent in ClrTypeUtilities.SafeGetEvents(clrType, flags) {
            if (name == nil || ClrTypeUtilities.EmittedMemberNameMatches(clrEvent, name)) &&
                !(overridden?.Covers(clrEvent.AddMethod) ?? false) {
                result.Add(ImportedMemberSymbol(receiver, clrEvent))
            }
        }
    }

    /// Returns the symbol of an imported member as read at [`receiver`](paramref): one instance per
    /// member and receiver, so two queries answer the same symbol.
    private func ImportedMemberSymbol(receiverType TypeSymbol?, member MemberInfo) Symbol {
        let receiver = if receiverType == nil {
            default(TypeSymbol?)
        } else {
            UnwrapNullability(receiverType)
        }
        let key = (member, receiver)
        return importedMembers.GetOrAdd(
            key,
            (k(MemberInfo, TypeSymbol?)) -> CreateImportedMemberSymbol(receiver, member)
        )
    }

    private let importedMembers ConcurrentDictionary[(MemberInfo, TypeSymbol?), Symbol] = ConcurrentDictionary[
        (MemberInfo, TypeSymbol?),
        Symbol
    ]()

    // The type of each member goes through the ADR-0193 readers at the receiver, never through the
    // CLR type, so that `[Nullable]` metadata and the receiver's type arguments apply.
    private func CreateImportedMemberSymbol(receiver TypeSymbol?, member MemberInfo) Symbol {
        let owner = receiver ?? ImportedTypeSymbol.GetWithoutNullability(
            member.DeclaringType ?? typeof(object),
            NullabilityFreeReason.TypeStructure
        )
        let declaringType = ImportedTypeSymbol.GetWithoutNullability(
            member.DeclaringType ?? typeof(object),
            NullabilityFreeReason.TypeStructure
        )
        switch member {
            case property is PropertyInfo {
                let propertyType = MemberLookup.GetClrPropertyTypeSymbol(owner, property)
                let getter MethodInfo? = property.GetMethod
                let setter MethodInfo? = property.SetMethod
                let accessor = getter ?? setter
                let symbol = PropertySymbol(
                    property.Name,
                    if propertyType is ByRefTypeSymbol byRef {
                        byRef.PointeeType
                    } else {
                        propertyType
                    },
                    ClrAccessibility(property.GetAccessors(true)),
                    hasGetter: property.CanRead,
                    hasSetter: property.CanWrite,
                    isAutoProperty: false,
                    isVirtual: accessor?.IsVirtual == true,
                    isOverride: accessor != nil && ClrTypeUtilities.SafeIsOverride(accessor),
                    isStatic: accessor?.IsStatic == true,
                    isInitOnly: setter != nil && ImportedTypeSymbol.IsInitOnlySetter(setter),
                    getterAccessibility: if getter == nil {
                        default(Accessibility?)
                    } else {
                        ClrAccessibility(getter.Attributes)
                    },
                    setterAccessibility: if setter == nil {
                        default(Accessibility?)
                    } else {
                        ClrAccessibility(setter.Attributes)
                    },
                    metadataIsAbstract: accessor?.IsAbstract == true
                )
                symbol.ReturnRefKind = RefCapabilities.GetReturnRefKind(property)
                symbol.ImportedMember = property
                symbol.AnchorContainingType(declaringType)
                return symbol
            }
            case field is FieldInfo {
                let symbol = FieldSymbol(
                    field.Name,
                    MemberLookup.GetClrFieldTypeSymbol(owner, field),
                    ClrAccessibility(field.Attributes),
                    isReadOnly: field.IsInitOnly,
                    isStatic: field.IsStatic,
                    isConst: field.IsLiteral
                )
                symbol.ImportedMember = field
                if field.IsLiteral {
                    symbol.SetConstantValue(field.GetRawConstantValue())
                }
                symbol.AnchorContainingType(declaringType)
                return symbol
            }
            case clrEvent is EventInfo {
                let adder MethodInfo? = clrEvent.AddMethod
                let symbol = EventSymbol(
                    clrEvent.Name,
                    MemberLookup.GetClrEventHandlerTypeSymbol(owner, clrEvent),
                    ClrAccessibility(clrEvent.GetAddMethod(true)?.Attributes ?? MethodAttributes.Private),
                    isFieldLike: false,
                    isVirtual: adder?.IsVirtual == true,
                    isOverride: adder != nil && ClrTypeUtilities.SafeIsOverride(adder),
                    isStatic: adder?.IsStatic == true
                )
                symbol.ImportedMember = clrEvent
                symbol.AnchorContainingType(declaringType)
                return symbol
            }
            default {
                let method = cast[MethodInfo](member)
                let function = ImportedFunctionSymbol(
                    method.Name,
                    ImportedClassSymbol(method.DeclaringType ?? typeof(object), declaration: nil),
                    method,
                    declaration: nil,
                    returnTypeOverride: MemberLookup.GetClrMethodReturnTypeSymbol(owner, method)
                )
                function.AnchorContainingType(declaringType)
                return function
            }
        }
    }

    // The most accessible of the accessors, as C# reports a property's declared accessibility.
    private func ClrAccessibility(accessors[]MethodInfo) Accessibility {
        if accessors.Any((a MethodInfo) -> a.IsPublic) {
            return Accessibility.Public
        }
        if accessors.Any((a MethodInfo) -> a.IsFamily || a.IsFamilyOrAssembly) {
            return Accessibility.Protected
        }
        if accessors.Any((a MethodInfo) -> a.IsAssembly || a.IsFamilyAndAssembly) {
            return Accessibility.Internal
        }
        return Accessibility.Private
    }

    private func ClrAccessibility(attributes FieldAttributes) Accessibility {
        let access = attributes & FieldAttributes.FieldAccessMask
        return switch access {
            case FieldAttributes.Public: Accessibility.Public
            case FieldAttributes.Family: Accessibility.Protected
            case FieldAttributes.FamORAssem: Accessibility.Protected
            case FieldAttributes.Assembly: Accessibility.Internal
            case FieldAttributes.FamANDAssem: Accessibility.Internal
            default: Accessibility.Private
        }
    }

    private func ClrAccessibility(attributes MethodAttributes) Accessibility {
        let access = attributes & MethodAttributes.MemberAccessMask
        return switch access {
            case MethodAttributes.Public: Accessibility.Public
            case MethodAttributes.Family: Accessibility.Protected
            case MethodAttributes.FamORAssem: Accessibility.Protected
            case MethodAttributes.Assembly: Accessibility.Internal
            case MethodAttributes.FamANDAssem: Accessibility.Internal
            default: Accessibility.Private
        }
    }

    /// Judges whether a member of a source type is accessible from the declaration that encloses a position.
    private class MemberAccessContext {
        private let enclosingType StructSymbol?
        private let enclosingFunction FunctionSymbol?

        init(enclosing Symbol?) {
            enclosingFunction = switch enclosing {
                case function is FunctionSymbol: function
                case property is PropertySymbol: property.GetterSymbol ?? property.SetterSymbol
                default: default(FunctionSymbol?)
            }
            enclosingType = switch enclosing {
                case structure is StructSymbol: structure
                default: enclosing?.ContainingType as StructSymbol
            }
        }

        private func IsStaticMember(member Symbol) bool -> switch member {
            case field is FieldSymbol: field.IsStatic
            case property is PropertySymbol: property.IsStatic
            case clrEvent is EventSymbol: clrEvent.IsStatic
            case function is FunctionSymbol: function.IsStatic || function.StaticOwnerType != nil
            default: false
        }

        // A member copied for a constructed base has no containing type; its declaration names the owner.
        private func OwnerInHierarchy(member Symbol, receiver TypeSymbol) TypeSymbol {
            if receiver is StructSymbol structure && !member.DeclaringSyntaxNodes.IsDefaultOrEmpty {
                let declared = member.DeclaringSyntaxNodes[0].FirstAncestorOrSelf[StructDeclarationSyntax]()
                if declared != nil {
                    for candidate in structure.GetHierarchy() {
                        if DeclaredBy(candidate, declared) {
                            return candidate
                        }
                    }
                }
            }
            return receiver
        }

        // Declaration identity, with the parts of a partial type: two types can share a simple name.
        private func DeclaredBy(candidate StructSymbol, declared StructDeclarationSyntax) bool {
            let declaration = (candidate.Definition ?? candidate).Declaration
            if declaration == nil {
                return false
            }
            if object.ReferenceEquals(declaration, declared) {
                return true
            }
            if declaration.PartialPartLocations.IsDefaultOrEmpty {
                return false
            }
            for location in declaration.PartialPartLocations {
                if SourcePathIdentity.AreSame(location.FileName, declared.SyntaxTree.Text?.FileName) &&
                    location
                    .Span
                    .Start == declared
                    .Identifier
                    .Span
                    .Start {
                    return true
                }
            }
            return false
        }

        func CanAccess(member Symbol, receiver TypeSymbol) bool {
            let accessibility = switch member {
                case field is FieldSymbol: field.Accessibility
                case property is PropertySymbol: property.Accessibility
                case event is EventSymbol: event.Accessibility
                case function is FunctionSymbol: function.Accessibility
                default: Accessibility.Public
            }
            if accessibility == Accessibility.Public || accessibility == Accessibility.Internal {
                return true
            }
            let declaring = member.ContainingType ?? OwnerInHierarchy(member, receiver)
            // The binder rejects a protected instance member read through a receiver of the base type (GS0379).
            if accessibility == Accessibility.Protected &&
                enclosingFunction != nil &&
                !IsStaticMember(member) &&
                AccessibilityChecker.ViolatesProtectedReceiverRule(
                accessibility,
                declaring,
                receiver,
                enclosingFunction
            ) {
                return false
            }
            if declaring is InterfaceSymbol {
                return AccessibilityChecker.IsAccessible(accessibility, declaring, enclosingFunction)
            }
            // The function knows its lexical enclosing types, a nested interface's among them.
            if enclosingFunction != nil {
                return AccessibilityChecker.IsAccessible(accessibility, declaring, enclosingFunction)
            }
            return AccessibilityChecker.IsAccessibleFromType(accessibility, declaring as StructSymbol, enclosingType)
        }
    }
}
