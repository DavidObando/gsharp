// <copyright file="StatementBinder.NarrowingLoops.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// ADR-0213 sections 6, 7, 11 and 13: the syntactic region lower bound `Lower(S, R)`
/// for loops and backward-jump spans, computed from (cref:RegionEffectScanner) and
/// (cref:BackwardJumpSpans).
internal partial class StatementBinder {
    private var regionScanner RegionEffectScanner? = nil

    private func GetRegionScanner() RegionEffectScanner {
        if regionScanner == nil {
            regionScanner = RegionEffectScanner()
        }
        return regionScanner!!
    }

    /// The decision of the consumer rule of section 7 for one fact.
    private sealed class RegionKillDecision {
        init(killed bool, rule string, row string) {
            Killed = killed
            Rule = rule
            Row = row
        }

        prop Killed bool {
            get;
        }

        /// Gets the rule that decided: W1 to W8, P7 or a shared predicate (A2, A3).
        prop Rule string {
            get;
        }

        /// Gets the row of ADR-0213 section 16 that the kill belongs to, or `-`.
        prop Row string {
            get;
        }
    }

    /// The writes of a region resolved at the entry scope of the region.
    private sealed class ResolvedRegionWrites {
        init() {
            Roots = List[VariableSymbol]()
            Writes = List[List[RegionWrite]]()
            ImplicitMemberWrite = false
            WritesViaCallArgument = false
        }

        prop Roots List[VariableSymbol] {
            get;
        }

        prop Writes List[List[RegionWrite]] {
            get;
        }

        /// Whether a write names a field or a property of the enclosing type (rule W1).
        prop ImplicitMemberWrite bool {
            get;
            set;
        }

        prop WritesViaCallArgument bool {
            get;
            set;
        }

        /// Whether an operator of the region may be user-defined: an operand is not a plain name or a literal, or
        /// a name that is an operand has a type that is not built in.
        prop RunsUserOperator bool {
            get;
            set;
        }

        /// Whether the region writes a bare property (a setter), or converts a value in a package that declares a
        /// user-defined conversion (rule W4).
        prop RunsUserCodeOnWrite bool {
            get;
            set;
        }

        /// Whether a constant pattern of the region can call a user `Equals` (ADR-0208 R19), a plain call (A3).
        prop PatternTestsCallEquals bool {
            get;
            set;
        }

        /// Whether a bare name that the region reads binds to a property of the enclosing type (rule W5).
        prop ReadsProperty bool {
            get;
            set;
        }

        /// Whether such a property has a getter with user code (not an auto property, ADR-0208 R14).
        prop ReadsUserCodeProperty bool {
            get;
            set;
        }

        /// The answers that do not depend on the fact, computed once for all the facts of the region: whether a
        /// call is indirect (`nil` until asked) and whether a member or index read can run user code.
        prop CallsAreIndirect bool? {
            get;
            set;
        }

        prop ReadsRunUserCode bool? {
            get;
            set;
        }

        prop ReferenceStorageRunsUserCode bool? {
            get;
            set;
        }

        /// Whether a bare static member that the region reads or writes has an owner whose initializer runs user
        /// code (ADR-0208 R11, #5520).
        prop TouchesInitializingType bool {
            get;
            set;
        }

        /// Whether a nil comparison of the region can select a user-defined `==`.
        prop NilCompareRunsUserOperator bool {
            get;
            set;
        }

        /// Whether a conversion site of the region can run a conversion operator or a structural projection.
        prop ConversionsRunUserCode bool {
            get;
            set;
        }
    }

    private func SameRoot(first VariableSymbol, second VariableSymbol) bool {
        if object.ReferenceEquals(first, second) {
            return true
        }
        // A lookup of an implicit member makes a new symbol each time. The member is the identity.
        let firstImplicit = first is ImplicitFieldVariableSymbol or
            ImplicitPropertyVariableSymbol or
            ImplicitStaticFieldVariableSymbol or
            ImplicitStaticPropertyVariableSymbol
        return firstImplicit && first.GetType() == second.GetType() && first.Name == second.Name
    }

    // Resolves a bare name that is not a variable of the entry scope through the binder's static-import,
    // default-interface, and inherited-CLR member fallbacks (#5470).
    private func TryResolveBareFallbackMember(
        name string,
        out type TypeSymbol?,
        out isProperty bool,
        out getterRunsUserCode bool,
        out touchesInitializingType bool,
        forWrite bool = false
    ) bool {
        type = nil
        isProperty = false
        getterRunsUserCode = false
        touchesInitializingType = false
        if !forWrite && ExpressionBinder.ResolvesBareMethodGroup($scope, binderCtx, function, name) {
            return false
        }
        if $scope.SubmissionImports is {} submissions &&
            $scope.References is {} references &&
            submissions.TryFindMemberContainer(references, name, out var programType) &&
            programType != nil &&
            TryResolveClrStaticMemberByBareName(
            programType,
            name,
            out type,
            out isProperty,
            out getterRunsUserCode,
            out touchesInitializingType
        ) {
            return true
        }
        let hasLexicalOwner = (function?.StaticOwnerType ?? function?.ReceiverType) is {} lexicalOwner && MemberLookup(
            binderCtx
        ).FindLexicalMemberOwner(lexicalOwner, name) != nil
        if !hasLexicalOwner {
            var match StructSymbol? = nil
            var ambiguous = false
            for importedType in binderCtx.GetStaticImportTypes() {
                if !BinderContext.ImportedTypeExposesStaticMember(importedType, name) {
                    continue
                }
                if match == nil {
                    match = importedType
                } else if !object.ReferenceEquals(match, importedType) {
                    ambiguous = true
                    break
                }
            }
            if !ambiguous && match != nil {
                if TypeMemberModel.TryGetStaticFieldIncludingInherited(
                    match,
                    name,
                    out var staticField,
                    out var fieldOwner
                ) {
                    type = fieldOwner.SubstituteMemberType(staticField.Type)
                    touchesInitializingType = !staticField.IsConst && TypeInitializationRunsUserCode(fieldOwner, true)
                    return true
                }
                if TypeMemberModel.TryGetStaticPropertyIncludingInherited(
                    match,
                    name,
                    out var staticProperty,
                    out var propertyOwner
                ) {
                    type = propertyOwner.SubstituteMemberType(staticProperty.Type)
                    isProperty = true
                    getterRunsUserCode = SourcePropertyRunsUserCode(staticProperty, nil)
                    touchesInitializingType = TypeInitializationRunsUserCode(propertyOwner, true)
                    return true
                }
                if !forWrite && ExpressionBinder.HasNonVariadicMethod(
                    TypeMemberModel.GetMethods(match, name, MemberQuery.InheritedStatic(MemberKinds.Method))
                ) {
                    return false
                }
                if TypeMemberModel.GetNearestImportedBase(match)
                    ?.ClrType is {} baseClr &&
                    TryResolveClrStaticMemberByBareName(
                    baseClr,
                    name,
                    out type,
                    out isProperty,
                    out getterRunsUserCode,
                    out touchesInitializingType
                ) {
                    return true
                }
            } else if !ambiguous {
                var clrMatch Type? = nil
                var clrAmbiguous = false
                for clrType in $scope.EnumerateStaticImportClrTypes() {
                    if !BinderContext.ClrTypeExposesStaticMember(clrType, name) {
                        continue
                    }
                    if clrMatch == nil {
                        clrMatch = clrType
                    } else if !clrMatch.IsSameAs(clrType) {
                        clrAmbiguous = true
                        break
                    }
                }
                if !clrAmbiguous &&
                    clrMatch != nil &&
                    TryResolveClrStaticMemberByBareName(
                    clrMatch,
                    name,
                    out type,
                    out isProperty,
                    out getterRunsUserCode,
                    out touchesInitializingType
                ) {
                    return true
                }
            }
        }
        if ExpressionBinder.TryResolveInheritedClrInstanceMemberByBareName(
            binderCtx,
            function,
            name,
            out var thisParameter,
            out var clrMember
        ) {
            type = ExpressionBinder.GetInheritedClrMemberType(thisParameter.Type, clrMember)
            if clrMember is PropertyInfo clrProperty {
                isProperty = true
                getterRunsUserCode = !IsStableClrGetter(clrProperty)
            }
            return true
        }
        if ExpressionBinder.TryResolveInterfaceInstancePropertyByBareName(
            binderCtx,
            function,
            name,
            out _,
            out var thisInterface
        ) {
            isProperty = true
            getterRunsUserCode = true
            if TypeMemberModel.TryGetPropertyWithOwner(thisInterface, name, out var property, out var owner) &&
                !property!!.IsIndexer {
                type = (owner as InterfaceSymbol)?.SubstituteMemberType(property!!.Type) ?? property!!.Type
            } else if MemberLookup.GetInterfaceImportedBaseInstanceProperty(
                thisInterface,
                name,
                out var importedReceiver
            ) is {} importedProperty &&
                importedReceiver != nil {
                type = ExpressionBinder.GetInheritedClrMemberType(importedReceiver, importedProperty)
            }
            return true
        }
        return false
    }

    private func TryResolveClrStaticMemberByBareName(
        clrType Type,
        name string,
        out type TypeSymbol?,
        out isProperty bool,
        out getterRunsUserCode bool,
        out touchesInitializingType bool
    ) bool {
        type = nil
        isProperty = false
        getterRunsUserCode = false
        touchesInitializingType = false
        let imported = ImportedClassSymbol(clrType, declaration: nil, references: $scope.References)
        if !imported.TryLookupMember(name, ne: nil, out var member) {
            return false
        }
        switch member {
            case property is PropertyInfo {
                type = ClrNullability.GetPropertyTypeSymbol(property)
                isProperty = true
                getterRunsUserCode = !IsStableClrGetter(property)
                touchesInitializingType = ClrStaticMemberOwnerInitializes(property.DeclaringType ?? clrType)
                return true
            }
            case field is FieldInfo {
                type = ClrNullability.GetFieldTypeSymbol(field)
                touchesInitializingType = !ConstantExpressionEvaluator.TryGetClrFieldConstantValue(field, out _) &&
                    ClrStaticMemberOwnerInitializes(field.DeclaringType ?? clrType)
                return true
            }
            default {
                return false
            }
        }
    }

    private func ClrStaticMemberOwnerInitializes(owner Type) bool -> if ReflectionType(owner) is {} reflected {
        ClrTypeUtilities.SafeGetConstructors(
            reflected,
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
        )
            .Length > 0
    } else {
        true
    }

    private func TryLookupRegionVariableType(name string) TypeSymbol? {
        if $scope.TryLookupSymbol(name) is VariableSymbol variable {
            return variable.Type
        }
        return if TryResolveBareFallbackMember(name, out var type, out _, out _, out _) {
            type
        } else {
            default(TypeSymbol?)
        }
    }

    private func ResolveRegionWrites(effects RegionEffects) ResolvedRegionWrites {
        let resolved = ResolvedRegionWrites()
        if ConversionsRunUserCode(effects) {
            resolved.ConversionsRunUserCode = true
            resolved.RunsUserCodeOnWrite = true
        }
        if effects.ContainsOperatorCandidate {
            // A unary operator that is not predefined for a literal or a built-in operand calls a user-defined or
            // an extension operator (`-"x"`), as does a binary one with an extension operator.
            resolved.RunsUserOperator = effects.OperatorHasUnresolvedOperand || OperatorsRunUserCode(effects, false)
        }
        for test in effects.PatternTests {
            if PatternTestRunsUserCode(test, effects) {
                resolved.PatternTestsCallEquals = true
                break
            }
        }
        for name in effects.NilCompareOperandNames {
            if NilCompareNameRunsUserOperator(name, effects) {
                resolved.RunsUserOperator = true
                resolved.NilCompareRunsUserOperator = true
            }
        }
        for name in effects.BareReads {
            let symbol = $scope.TryLookupSymbol(name)
            if symbol is ImplicitPropertyVariableSymbol or ImplicitStaticPropertyVariableSymbol {
                resolved.ReadsProperty = true
            }
            // ADR-0208 R14 (#5599): the one accessor decision; an implicit instance read is through `this`.
            if (
                symbol is ImplicitPropertyVariableSymbol instanceProperty &&
                    SourcePropertyRunsUserCode(
                    instanceProperty.Property,
                    ExpressionBinder.GetEffectiveThisParameter(binderCtx, function)?.Type
                )
            ) ||
                (
                symbol is ImplicitStaticPropertyVariableSymbol staticProperty &&
                    SourcePropertyRunsUserCode(staticProperty.Property, nil)
            ) {
                resolved.ReadsUserCodeProperty = true
            }
            if symbol is not VariableSymbol && !ExpressionBinder.ResolvesBareMethodGroup(
                $scope,
                binderCtx,
                function,
                name
            ) &&
                TryResolveBareFallbackMember(
                name,
                out _,
                out var isProperty,
                out var getterRunsUserCode,
                out var touchesInitializingType
            ) {
                if isProperty {
                    resolved.ReadsProperty = true
                    if getterRunsUserCode {
                        resolved.ReadsUserCodeProperty = true
                    }
                }
                if touchesInitializingType {
                    resolved.TouchesInitializingType = true
                    resolved.RunsUserCodeOnWrite = true
                }
            }
            if BareStaticOwnerInitializes(symbol) {
                resolved.TouchesInitializingType = true
                resolved.RunsUserCodeOnWrite = true
            }
        }
        for write in effects.Writes {
            if write.ViaCallArgument {
                resolved.WritesViaCallArgument = true
            }
            let symbol = $scope.TryLookupSymbol(write.Name)
            if symbol is not VariableSymbol variable {
                if TryResolveBareFallbackMember(
                    write.Name,
                    out _,
                    out var isProperty,
                    out _,
                    out var touchesInitializingType,
                    forWrite: true
                ) {
                    resolved.ImplicitMemberWrite = true
                    if isProperty || touchesInitializingType {
                        resolved.RunsUserCodeOnWrite = true
                    }
                    if touchesInitializingType {
                        resolved.TouchesInitializingType = true
                    }
                }
                continue
            }
            if variable is ImplicitPropertyVariableSymbol or ImplicitStaticPropertyVariableSymbol {
                resolved.RunsUserCodeOnWrite = true
            }
            if BareStaticOwnerInitializes(variable) {
                resolved.TouchesInitializingType = true
                resolved.RunsUserCodeOnWrite = true
            }
            if variable is ImplicitFieldVariableSymbol or
                ImplicitPropertyVariableSymbol or
                ImplicitStaticFieldVariableSymbol or
                ImplicitStaticPropertyVariableSymbol {
                resolved.ImplicitMemberWrite = true
            }
            var index = -1
            for var i = 0; i < resolved.Roots.Count; i++ {
                if SameRoot(resolved.Roots[i], variable) {
                    index = i
                    break
                }
            }
            if index < 0 {
                resolved.Roots.Add(variable)
                resolved.Writes.Add(List[RegionWrite]())
                index = resolved.Roots.Count - 1
            }
            resolved.Writes[index].Add(write)
        }
        return resolved
    }

    // The variables that one call of the region passes more than once with at least one `ref`/`out`
    // (ADR-0208 R12, amendment A3): the aliasing is visible at the call site.
    // The storage that a call operand names: the variable at the end of its `ref` alias chain at the entry
    // scope. Two spellings that reach one storage are one operand (ADR-0208 R12, amendment A3).
    private func SameOperandStorage(first string, second string) bool {
        if first == second {
            return true
        }
        let left = $scope.TryLookupSymbol(first)
        let right = $scope.TryLookupSymbol(second)
        if left is VariableSymbol leftVariable && right is VariableSymbol rightVariable {
            return ChainsOverlap(leftVariable, rightVariable)
        }
        return false
    }

    // The variables that one call of the region passes more than once with at least one `ref`/`out`
    // (ADR-0208 R12, amendment A3): the aliasing is visible at the call site.
    private func IsCallAliasedName(effects RegionEffects, name string) bool {
        for call in effects.Calls {
            var byReference = 0
            var total = 0
            for text in call.ByReferenceNames {
                if SameOperandStorage(text, name) {
                    byReference++
                    total++
                }
            }
            for text in call.ByValueNames {
                if SameOperandStorage(text, name) {
                    total++
                }
            }
            if byReference > 0 && total >= 2 {
                return true
            }
        }
        return false
    }

    // Whether the region runs code that it does not show: a call, a getter, a user operator or a conversion.
    private func RegionRunsCode(effects RegionEffects, resolved ResolvedRegionWrites) bool -> effects.ContainsCall ||
        effects.ContainsSuspension ||
        effects.ContainsIteration ||
        RunsUserCodeOnMemberRead(effects, resolved) ||
        resolved.RunsUserOperator ||
        resolved.RunsUserCodeOnWrite ||
        resolved.PatternTestsCallEquals

    // ADR-0213 W5 (#5549): whether a member, index or bare property read of the region can run user code.
    private func RunsUserCodeOnMemberRead(effects RegionEffects, resolved ResolvedRegionWrites) bool {
        if resolved.ReadsUserCodeProperty {
            return true
        }
        if !effects.ContainsMemberRead && effects.NilCompareOperandPaths.Count == 0 {
            return false
        }
        if resolved.ReadsRunUserCode == nil {
            resolved.ReadsRunUserCode = (
                effects
                    .MemberReads
                    .Count == 0 &&
                    effects
                    .PatternReads
                    .Count == 0 &&
                    effects
                    .NilCompareOperandPaths
                    .Count == 0
            ) ||
                ReadsRunUserCode(effects, false)
        }
        return resolved.ReadsRunUserCode == true
    }

    private func CallIsIndirect(call RegionCall, effects RegionEffects) bool {
        switch call.Kind {
            case RegionCallKind.NamedInvocation {
                let symbol = $scope.TryLookupSymbol(call.CalleeName)
                // A function value, a parameter of function type, a construction (a constructor is no plain call,
                // ADR-0208 amendment A3), or a name that resolves to nothing.
                return symbol is VariableSymbol || symbol is TypeSymbol || symbol == nil
            }
            case RegionCallKind.ExpressionInvocation, RegionCallKind.Construction, RegionCallKind.Other {
                return true
            }
            case RegionCallKind.MemberInvocation {
                return MemberCallIsIndirect(call, effects)
            }
            default {
                return false
            }
        }
    }

    // A member call is a plain call (ADR-0208 amendment A3 keeps by-reference storage across a call to a method)
    // when the member is a method. A receiver that is a plain name of the entry scope, a variable or a type, is
    // resolved on its declared type and on the type its entry fact narrows it to. The call is indirect when it
    // invokes a receiver of function or delegate type, or when either type has a field, a property or an event of
    // the member's name (a function value of a class, an interface or a tuple element). It is a method call when
    // the types have only methods of that name, or none and an extension method of that name is visible. Otherwise
    // the region narrows the receiver to a type that the entry scope does not show, and the call is indirect. Any
    // other receiver is followed as a path (`ReceiverPathCallIsIndirect`).
    private func MemberCallIsIndirect(call RegionCall, effects RegionEffects) bool {
        let member = call.CalleeName
        let receiverName = call.ReceiverName
        if member == nil {
            return true
        }
        if receiverName == nil {
            return InvokesDelegate(member) || ReceiverPathCallIsIndirect(call.Receiver, member, effects)
        }
        let symbol = $scope.TryLookupSymbol(receiverName)
        var shape = 0
        var declaredType TypeSymbol? = nil
        var narrowedType TypeSymbol? = nil
        if symbol is VariableSymbol receiver {
            declaredType = StripAllNullability(receiver.Type)
            narrowedType = StripAllNullability(binderCtx.NarrowedVariables.Query(AccessPath.ForVariable(receiver)))
            shape = MemberShape(declaredType, member) | MemberShape(narrowedType, member)
            for test in effects.TypeTests {
                if test.Name == receiverName {
                    shape = shape | TestedMemberShape(test, member)
                }
            }
        } else if TryResolveBareFallbackMember(receiverName, out var fallbackType, out _, out _, out _) {
            declaredType = StripAllNullability(fallbackType)
            shape = MemberShape(declaredType, member) | MemberShape(ResolveTypeName(receiverName), member)
        } else {
            shape = MemberShape(ResolveTypeName(receiverName), member)
        }
        if (shape & MemberIsValue) != 0 {
            return true
        }
        if (shape & MemberIsMethod) != 0 {
            return false
        }
        if declaredType == nil {
            return true
        }
        if HasExtensionFunction(declaredType, member) || HasExtensionFunction(narrowedType, member) {
            return false
        }
        return MemberLookup(binderCtx).CollectImportedExtensionMethods(member).Count == 0
    }

    // The kinds of the member on the type of a type test. A type that the entry scope does not resolve can have
    // any member. A name-shaped pattern whose name is not a type tests a constant (`case Kind.Name`), which
    // narrows nothing.
    private func TestedMemberShape(test RegionTypeTest, member string) int32 {
        if TestedType(test, out var testsConstant) is {} type {
            return MemberShape(type, member)
        }
        return if testsConstant {
            0
        } else {
            MemberIsValue
        }
    }

    // The type of a type test, or `nil` with [`testsConstant`](paramref) set when the pattern names a constant.
    private func TestedType(test RegionTypeTest, out testsConstant bool) TypeSymbol? {
        testsConstant = false
        let typeName = test.TypeName
        if typeName == nil {
            return nil
        }
        if ResolveTestedType(typeName, test.Arity) is {} type {
            return type
        }
        if test.MayBeConstant && (test.DeclaredInRegion || $scope.TryLookupSymbol(typeName) != nil) {
            testsConstant = true
            return nil
        }
        let dot = typeName.LastIndexOf('.')
        if test.MayBeConstant && dot > 0 && ResolveTypeName(typeName.Substring(0, dot)) != nil {
            testsConstant = true
        }
        return nil
    }

    // The type that a type test names: a type of the scope, an imported class of that arity or a full CLR name.
    private func ResolveTestedType(name string, arity int32) TypeSymbol? {
        if $scope.TryLookupSymbol(name) is TypeSymbol type {
            return type
        }
        if arity == 0 {
            if ResolveTypeName(name) is {} named {
                return named
            }
        } else if $scope.TryLookupTypeAlias(name, arity, out var source) && source != nil {
            return source
        } else if $scope.TryLookupImportedClassByArity(name, arity, nil, out var imported) && imported != nil {
            return TypeSymbol.FromClrTypeWithoutNullability(imported.ClassType, NullabilityFreeReason.ResolvedTypeName)
        }
        let fullName = if arity == 0 {
            name
        } else {
            name + "`" + arity.ToString()
        }
        if binderCtx.References.TryResolveType(fullName, out var clrType) {
            return TypeSymbol.FromClrTypeWithoutNullability(clrType, NullabilityFreeReason.ResolvedTypeName)
        }
        return nil
    }

    private func ResolveTypeName(name string) TypeSymbol? {
        for builtin in BuiltInTypes() {
            if builtin.Name == name {
                return builtin
            }
        }
        let symbol = $scope.TryLookupSymbol(name)
        if symbol is TypeSymbol type {
            return type
        }
        if symbol == nil {
            return ResolveConstructedType(name)
        }
        return nil
    }

    // A resolved receiver type: a type symbol, or a closed CLR type that a member of an imported type returns.
    private sealed class ReceiverType {
        init(symbol TypeSymbol?, clr Type?) {
            Symbol = symbol
            Clr = clr
        }

        prop Symbol TypeSymbol? {
            get;
        }

        prop Clr Type? {
            get;
        }
    }

    // A member call on a receiver that is not a plain name of the entry scope (a member chain, an element, a call
    // result, a local of the region) is a plain call only when the walker follows the receiver's path to types
    // whose members of that name are methods. A path that the entry scope cannot resolve, or one whose member
    // the region type-tests, is a function value of unknown origin.
    private func ReceiverPathCallIsIndirect(path RegionReceiverPath?, member string, effects RegionEffects) bool {
        if path == nil || path.Steps.Length > 0 && effects.ContainsMemberTypeTest {
            return true
        }
        let types = ResolveReceiverPath(path, effects)
        if types == nil {
            return true
        }
        var shape = 0
        for type in types {
            shape = shape | ReceiverShape(type, member)
        }
        if (shape & MemberIsValue) != 0 {
            return true
        }
        if (shape & MemberIsMethod) != 0 {
            return false
        }
        for type in types {
            if HasExtensionFunction(type.Symbol, member) {
                return false
            }
        }
        return MemberLookup(binderCtx).CollectImportedExtensionMethods(member).Count == 0
    }

    private func ReceiverShape(type ReceiverType, member string) int32 {
        if type.Clr is {} clr {
            return ClrTypeShape(clr, member)
        }
        return MemberShape(type.Symbol, member)
    }

    // The types that the receiver can have at the call site, or `nil` when a part does not resolve.
    private func ResolveReceiverPath(
        path RegionReceiverPath,
        effects RegionEffects,
        keepNullableValueAtEnd bool = false,
        keepReferenceNullabilityAtEnd bool = false,
        forStorageAtEnd bool = false,
        forOutStorageAtEnd bool = false
    ) List[ReceiverType]? {
        let savedValue = keepNullableValueTypes
        let savedReference = keepReferenceNullability
        let savedStorage = forStorageRoot
        let savedOutStorage = forOutStorageRoot
        try {
            keepNullableValueTypes = keepNullableValueAtEnd || path.Steps.Length > 0
            keepReferenceNullability = keepReferenceNullabilityAtEnd && path.Steps.Length == 0
            forStorageRoot = forStorageAtEnd && path.Steps.Length == 0
            forOutStorageRoot = forOutStorageAtEnd && path.Steps.Length == 0
            return ResolveReceiverPathCore(path, effects, keepNullableValueAtEnd, keepReferenceNullabilityAtEnd)
        } finally {
            keepNullableValueTypes = savedValue
            keepReferenceNullability = savedReference
            forStorageRoot = savedStorage
            forOutStorageRoot = savedOutStorage
        }
    }

    // Whether (cref:AddSymbolType) keeps a nullable value type: on intermediate receiver steps and when requested at
    // the end of a path.
    private var keepNullableValueTypes bool = false

    // Whether (cref:AddSymbolType) keeps reference nullability at the end of an overload-resolution argument path.
    private var keepReferenceNullability bool = false

    // Whether (cref:AddRootTypes) resolves a root variable's storage type for a by-reference argument.
    private var forStorageRoot bool = false

    // Whether (cref:AddRootTypes) resolves a root variable's declared storage type for an `out` argument.
    private var forOutStorageRoot bool = false

    private func ResolveReceiverPathCore(
        path RegionReceiverPath,
        effects RegionEffects,
        keepNullableValueAtEnd bool,
        keepReferenceNullabilityAtEnd bool
    ) List[ReceiverType]? {
        var types = List[ReceiverType]()
        if path.RootType != nil {
            if ResolveTypeClause(path.RootType) is not{} declared {
                return nil
            }
            // A conversion site keeps the `?` of a nullable value type (`let local DateTime? = dt`).
            let nullable = if keepNullableValueTypes && path.RootType?.QuestionToken != nil {
                NullableTypeSymbol.Get(declared)
            } else {
                default(NullableTypeSymbol?)
            }
            types.Add(
                ReceiverType(
                    if nullable != nil &&
                        (keepReferenceNullability || NullableLifting.IsAnyValueTypeNullable(nullable)) {
                        nullable
                    } else {
                        declared
                    },
                    nil
                )
            )
        } else if path.RootLiteralType != nil {
            if Type.GetType(path.RootLiteralType) is not{} literal {
                return nil
            }
            types.Add(ReceiverType(nil, literal))
        } else if path.RootName is {} root {
            if !AddRootTypes(root, path.RootIsCall, effects, types) {
                return nil
            }
        } else {
            return nil
        }
        for var stepIndex = 0; stepIndex < path.Steps.Length; stepIndex++ {
            let step = path.Steps[stepIndex]
            let isLastStep = stepIndex == path.Steps.Length - 1
            keepNullableValueTypes = keepNullableValueAtEnd || !isLastStep
            keepReferenceNullability = keepReferenceNullabilityAtEnd && isLastStep
            forStorageRoot = false
            forOutStorageRoot = false
            let next = List[ReceiverType]()
            for type in types {
                let outcome = AddStepTypes(type, step, next)
                // A call that the type does not declare binds an extension method; its result type is the step's.
                if outcome == StepAbsent &&
                    step.Kind == RegionReceiverStepKind.Call &&
                    step.Name is {} method &&
                    AddExtensionResultTypes(type, method, next) {
                    continue
                }
                if outcome != StepFound {
                    return nil
                }
                // An extension method of the name can bind the call instead, with another result type, unless an
                // instance method of the receiver applies to the call step (#5662).
                if step.Kind == RegionReceiverStepKind.Call &&
                    step.Name is {} called &&
                    ExtensionMayBind(type, called, step.Arguments.Count) &&
                    !InstanceMethodAppliesToCallStep(type, step, effects) {
                    return nil
                }
            }
            types = Distinct(next)
            // Overloads and unions can multiply the candidates at each step; a path with too many does not resolve.
            if types.Count == 0 || types.Count > MaxReceiverTypes {
                return nil
            }
        }
        return types
    }

    private const MaxReceiverTypes int32 = 16

    // The result types of the extension methods of that name for the receiver: the source extension functions that
    // take it, or else the imported extension methods of that name whose result is a closed type. `false` when there
    // is none or a result does not resolve.
    private func AddExtensionResultTypes(receiver ReceiverType, method string, next List[ReceiverType]) bool {
        if receiver.Symbol is {} symbol {
            let functions = $scope.TryLookupExtensionFunctions(symbol, method)
            if !functions.IsDefaultOrEmpty {
                for function in functions {
                    if !AddSymbolType(ObservableCallResultType(function), next) {
                        return false
                    }
                }
                return true
            }
        }
        let imported = MemberLookup(binderCtx).CollectImportedExtensionMethods(method)
        if imported.Count == 0 {
            return false
        }
        for candidate in imported {
            if !AddClrType(candidate.ReturnType, ImmutableArray[TypeSymbol].Empty, nil, next) {
                return false
            }
        }
        return true
    }

    private func Distinct(types List[ReceiverType]) List[ReceiverType] {
        let distinct = List[ReceiverType]()
        for type in types {
            var seen = false
            for kept in distinct {
                if object.ReferenceEquals(kept.Symbol, type.Symbol) && kept.Clr == type.Clr {
                    seen = true
                    break
                }
            }
            if !seen {
                distinct.Add(type)
            }
        }
        return distinct
    }

    // The types of a root: a variable of the entry scope (declared, narrowed and type-tested in the region), a type,
    // or the result of a named call (a construction or the functions of that name).
    private func AddRootTypes(root string, isCall bool, effects RegionEffects, types List[ReceiverType]) bool {
        if root == RegionEffectScanner.ReturnTypeRoot {
            let enclosing = function
            return enclosing != nil &&
                !enclosing.IsReturnTypeInferred &&
                !enclosing.DefersReturnConversion &&
                AddSymbolType(enclosing.Type, types)
        }
        if isCall {
            if ResolveTypeName(root) is {} constructed {
                types.Add(ReceiverType(constructed, nil))
                return true
            }
            let functions = $scope.TryLookupFunctions(root)
            if functions.IsDefaultOrEmpty {
                return false
            }
            for function in functions {
                if !AddSymbolType(ObservableCallResultType(function), types) {
                    return false
                }
            }
            return true
        }
        let symbol = $scope.TryLookupSymbol(root)
        if symbol is VariableSymbol variable {
            if forStorageRoot {
                if forOutStorageRoot {
                    return AddSymbolType(variable.Type, types)
                }
                let declaredStorage = if variable.Type is ByRefTypeSymbol byRef {
                    byRef.PointeeType
                } else {
                    variable.Type
                }
                let narrowed = binderCtx.NarrowedVariables.Query(AccessPath.ForVariable(variable))
                let survives = narrowed != nil && NarrowingSurvivesRegion(variable, effects)
                if !survives {
                    if !AddSymbolType(declaredStorage, types) {
                        return false
                    }
                    if binderCtx.NonNullByRefVariables.Contains(variable) &&
                        !AddSymbolType(
                        ExpressionBinder.AddressedLeafStorageType(
                            BoundVariableExpression(nil, variable),
                            useEffectiveNullability: true,
                            binderCtx: binderCtx
                        ),
                        types
                    ) {
                        return false
                    }
                }
                if narrowed != nil &&
                    !AddSymbolType(
                    ExpressionBinder.AddressedLeafStorageType(
                        BoundVariableExpression(nil, variable, narrowedType: narrowed),
                        useEffectiveNullability: true,
                        binderCtx: binderCtx
                    ),
                    types
                ) {
                    return false
                }
                for test in effects.TypeTests {
                    if test.Name == root {
                        let tested = TestedType(test, out var testsConstant)
                        if tested != nil {
                            if !AddSymbolType(
                                ExpressionBinder.AddressedLeafStorageType(
                                    BoundVariableExpression(nil, variable, narrowedType: tested),
                                    useEffectiveNullability: true,
                                    binderCtx: binderCtx
                                ),
                                types
                            ) {
                                return false
                            }
                        } else if !testsConstant {
                            return false
                        }
                    }
                }
                return types.Count > 0
            }
            let narrowed = binderCtx.NarrowedVariables.Query(AccessPath.ForVariable(variable))
            // A narrowing that survives the region stands for the value, and the declared type loses its `?`. One that
            // the region can remove (a write, or a writer that the walker does not see) leaves the declared type.
            let survives = narrowed != nil && NarrowingSurvivesRegion(variable, effects)
            let keep = keepNullableValueTypes
            let keepReference = keepReferenceNullability
            keepNullableValueTypes = keep && !survives
            keepReferenceNullability = keepReference && !survives
            let declaredAdded = AddSymbolType(variable.Type, types)
            keepNullableValueTypes = keep
            keepReferenceNullability = keepReference
            if !declaredAdded {
                return false
            }
            if narrowed != nil && !AddSymbolType(narrowed, types) {
                return false
            }
            for test in effects.TypeTests {
                if test.Name == root {
                    let tested = TestedType(test, out var testsConstant)
                    if tested != nil {
                        types.Add(ReceiverType(tested, nil))
                    } else if !testsConstant {
                        return false
                    }
                }
            }
            return true
        }
        var found = false
        if TryResolveBareFallbackMember(root, out var fallbackType, out _, out _, out _) {
            if !AddSymbolType(fallbackType, types) {
                return false
            }
            found = true
        }
        if !forStorageRoot && ResolveTypeName(root) is {} named {
            types.Add(ReceiverType(named, nil))
            found = true
        }
        return found
    }

    private func NarrowingSurvivesRegion(variable VariableSymbol, effects RegionEffects) bool {
        for write in effects.Writes {
            if write.Name == variable.Name {
                return false
            }
        }
        return !MayBeMutatedByUnknownWrite(true, false, AccessPath.ForVariable(variable))
    }

    // Adds a type symbol without its nullability. A type parameter that a member returns is substituted by the
    // binder, which the walker does not do, so it does not resolve.
    private func AddSymbolType(type TypeSymbol?, types List[ReceiverType]) bool {
        let stripped = if keepReferenceNullability {
            let unref = if type is ByRefTypeSymbol byRef {
                byRef.PointeeType
            } else {
                type
            }
            if !keepNullableValueTypes && unref is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else if !keepNullableValueTypes && unref is PlatformTypeSymbol platform {
                platform.UnderlyingType
            } else {
                unref
            }
        } else if keepNullableValueTypes {
            StripReferenceNullability(type)
        } else {
            StripAllNullability(type)
        }
        if stripped == nil || TypeSymbol.ContainsTypeParameter(stripped) {
            return false
        }
        types.Add(ReceiverType(stripped, nil))
        return true
    }

    private func ResolveTypeClause(type TypeClauseSyntax) TypeSymbol? {
        if type.Identifier == nil || type.IsArray || type.IsTuple || type.IsFunction || type.IsFunctionPointer {
            return nil
        }
        if binderCtx.CurrentTypeParameters?.ContainsKey(FirstNameSegment(type.DottedName)) == true {
            return nil
        }
        let arity = if type.TypeArguments is {} arguments {
            arguments.Count
        } else {
            0
        }
        return ResolveTestedType(type.DottedName, arity)
    }

    private const StepAbsent int32 = 0
    private const StepFound int32 = 1
    private const StepUnresolved int32 = 2

    // Adds the types of one step from a receiver type. Returns `StepFound`, `StepAbsent` when the type has no member
    // that the step names, or `StepUnresolved` when a member that it names has a type that does not resolve.
    private func AddStepTypes(type ReceiverType, step RegionReceiverStep, next List[ReceiverType]) int32 {
        if type.Clr is {} clr {
            if NullableLifting.GetValueTypeNullableUnderlyingClr(clr) is {} underlyingClr {
                let nullableOutcome = AddClrStepTypes(clr, step, ImmutableArray[TypeSymbol].Empty, nil, next)
                if nullableOutcome == StepUnresolved {
                    return StepUnresolved
                }
                let underlyingOutcome = AddClrStepTypes(
                    underlyingClr,
                    step,
                    ImmutableArray[TypeSymbol].Empty,
                    nil,
                    next
                )
                if underlyingOutcome == StepUnresolved {
                    return StepUnresolved
                }
                return if nullableOutcome == StepFound || underlyingOutcome == StepFound {
                    StepFound
                } else {
                    StepAbsent
                }
            }
            return AddClrStepTypes(clr, step, ImmutableArray[TypeSymbol].Empty, nil, next)
        }
        let symbol = type.Symbol
        let elementStep = step.Kind == RegionReceiverStepKind.Index || step.Kind == RegionReceiverStepKind.Element
        switch symbol {
            case nil {
                return StepUnresolved
            }
            case nullable is NullableTypeSymbol {
                if StripAllNullability(nullable.UnderlyingType) is not{} underlying {
                    return StepUnresolved
                }
                let nullableOutcome = AddClrStepTypes(
                    typeof(Nullable[_]),
                    step,
                    ImmutableArray.Create[TypeSymbol](underlying),
                    typeof(Nullable[_]),
                    next
                )
                if nullableOutcome == StepUnresolved {
                    return StepUnresolved
                }
                let underlyingOutcome = AddStepTypes(ReceiverType(underlying, nil), step, next)
                if underlyingOutcome == StepUnresolved {
                    return StepUnresolved
                }
                return if nullableOutcome == StepFound || underlyingOutcome == StepFound {
                    StepFound
                } else {
                    StepAbsent
                }
            }
            case array is ArrayTypeSymbol {
                if elementStep {
                    return Outcome(AddSymbolType(array.ElementType, next))
                }
                return AddClrStepTypes(typeof(Array), step, ImmutableArray[TypeSymbol].Empty, nil, next)
            }
            case slice is SliceTypeSymbol {
                if elementStep {
                    return Outcome(AddSymbolType(slice.ElementType, next))
                }
                // The length and the capacity of a slice are intrinsic `int32` reads.
                if step.Kind == RegionReceiverStepKind.Member && (step.Name == "Length" || step.Name == "Capacity") {
                    next.Add(ReceiverType(TypeSymbol.Int32, nil))
                    return StepFound
                }
            }
            case rectangular is RectangularArrayTypeSymbol {
                if elementStep {
                    return Outcome(AddSymbolType(rectangular.ElementType, next))
                }
                return AddClrStepTypes(typeof(Array), step, ImmutableArray[TypeSymbol].Empty, nil, next)
            }
            case tuple is TupleTypeSymbol {
                if step.Kind == RegionReceiverStepKind.Member && step.Name is {} elementName {
                    if tuple.TryGetElementIndexByName(elementName, out var element) {
                        return Outcome(AddSymbolType(tuple.ElementTypes[element], next))
                    }
                    // `Item1` to `ItemN` name the elements of any tuple.
                    if elementName.StartsWith("Item", StringComparison.Ordinal) && int32.TryParse(
                        elementName.Substring(4),
                        out var position
                    ) &&
                        position >= 1 &&
                        position <= tuple
                        .ElementTypes
                        .Length {
                        return Outcome(AddSymbolType(tuple.ElementTypes[position - 1], next))
                    }
                }
            }
            case declared is StructSymbol {
                if step.Kind == RegionReceiverStepKind.Element {
                    return StepUnresolved
                }
                var found = false
                let hierarchy = declared.GetHierarchy()
                for level in hierarchy {
                    for candidate in level.GetMembers() {
                        if StepSelects(candidate, step) {
                            found = true
                            if !AddSymbolType(MemberType(candidate), next) {
                                return StepUnresolved
                            }
                        }
                    }
                }
                if found {
                    return StepFound
                }
                if hierarchy.Last().ImportedBaseType is {} importedBase {
                    return AddStepTypes(ReceiverType(importedBase, nil), step, next)
                }
                let objectOutcome = AddClrStepTypes(typeof(object), step, ImmutableArray[TypeSymbol].Empty, nil, next)
                if objectOutcome != StepAbsent || declared.IsClass {
                    return objectOutcome
                }
                return AddClrStepTypes(
                    typeof(Nullable[_]),
                    step,
                    ImmutableArray.Create[TypeSymbol](declared),
                    typeof(Nullable[_]),
                    next
                )
            }
            case contract is InterfaceSymbol {
                if step.Kind == RegionReceiverStepKind.Element {
                    return StepUnresolved
                }
                var found = false
                for level in contract.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    for candidate in InterfaceMembers(level) {
                        if StepSelects(candidate, step) {
                            found = true
                            if !AddSymbolType(MemberType(candidate), next) {
                                return StepUnresolved
                            }
                        }
                    }
                    // A base interface without the member is skipped.
                    for clrBase in level.BaseClrInterfaces {
                        let outcome = AddStepTypes(ReceiverType(clrBase, nil), step, next)
                        if outcome == StepUnresolved {
                            return StepUnresolved
                        }
                        found = found || outcome == StepFound
                    }
                }
                if found {
                    return StepFound
                }
                return AddClrStepTypes(typeof(object), step, ImmutableArray[TypeSymbol].Empty, nil, next)
            }
            case enumType is EnumSymbol {
                if step.Kind == RegionReceiverStepKind.Member && step.Name is {} enumMember && enumType.TryGetMember(
                    enumMember,
                    out _
                ) {
                    next.Add(ReceiverType(enumType, nil))
                    return StepFound
                }
                // An enum value has the members of `System.Enum` and `System.Nullable<T>`.
                let enumOutcome = AddClrStepTypes(typeof(Enum), step, ImmutableArray[TypeSymbol].Empty, nil, next)
                if enumOutcome != StepAbsent {
                    return enumOutcome
                }
                return AddClrStepTypes(
                    typeof(Nullable[_]),
                    step,
                    ImmutableArray.Create[TypeSymbol](enumType),
                    typeof(Nullable[_]),
                    next
                )
            }
            case imported is ImportedTypeSymbol {
                if imported.OpenDefinition is {} definition && !imported.TypeArguments.IsDefaultOrEmpty {
                    let importedOutcome = AddClrStepTypes(definition, step, imported.TypeArguments, definition, next)
                    if importedOutcome != StepAbsent || !imported.IsValueType {
                        return importedOutcome
                    }
                    return AddClrStepTypes(
                        typeof(Nullable[_]),
                        step,
                        ImmutableArray.Create[TypeSymbol](imported),
                        typeof(Nullable[_]),
                        next
                    )
                }
            }
            default { }
        }
        if symbol?.ClrType is not{} clrType {
            return StepUnresolved
        }
        let arguments = if symbol is ImportedTypeSymbol importedType {
            importedType.TypeArguments
        } else {
            ImmutableArray[TypeSymbol].Empty
        }
        let clrOutcome = AddClrStepTypes(clrType, step, arguments, nil, next)
        if clrOutcome != StepAbsent || symbol == nil || !symbol.IsValueType {
            return clrOutcome
        }
        return AddClrStepTypes(
            typeof(Nullable[_]),
            step,
            ImmutableArray.Create[TypeSymbol](symbol),
            typeof(Nullable[_]),
            next
        )
    }

    private func Outcome(resolved bool) int32 -> if resolved {
        StepFound
    } else {
        StepUnresolved
    }

    private func InterfaceMembers(contract InterfaceSymbol) List[Symbol] {
        let members = List[Symbol]()
        members.AddRange(contract.Properties)
        members.AddRange(contract.Events)
        members.AddRange(contract.Methods)
        members.AddRange(contract.StaticMethods)
        members.AddRange(contract.StaticFields)
        members.AddRange(contract.ConstFields)
        return members
    }

    private func StepSelects(candidate Symbol, step RegionReceiverStep) bool {
        switch step.Kind {
            case RegionReceiverStepKind.Member {
                return candidate.Name == step.Name &&
                    (
                    candidate is FieldSymbol ||
                        candidate is PropertySymbol{IsIndexer: false} ||
                        candidate is EventSymbol
                )
            }
            case RegionReceiverStepKind.Call {
                return candidate.Name == step.Name && candidate is FunctionSymbol
            }
            case RegionReceiverStepKind.Index {
                return candidate is PropertySymbol{IsIndexer: true}
            }
            default {
                return false
            }
        }
    }

    private func ObservableCallResultType(function FunctionSymbol) TypeSymbol? {
        if function.IsReturnTypeInferred || function.Type == TypeSymbol.Error {
            return nil
        }
        if !function.IsAsync || function.IsAsyncVoid || AsyncIteratorDetection.IsAsyncIteratorReturnType(
            function.Type
        ) {
            return function.Type
        }
        if TypeSymbol.ContainsTypeParameter(function.Type) {
            return nil
        }
        let wrapperName = if function.AsyncReturnsValueTask {
            "System.Threading.Tasks.ValueTask"
        } else {
            "System.Threading.Tasks.Task"
        }
        if function.Type == TypeSymbol.Void {
            return if binderCtx.References.TryResolveType(wrapperName, out var taskType) && taskType != nil {
                ImportedTypeSymbol.GetWithoutNullability(taskType, NullabilityFreeReason.TypeLiteral)
            } else {
                default(TypeSymbol?)
            }
        }
        if !binderCtx.References.TryResolveType(wrapperName + "`1", out var openTask) || openTask == nil {
            return nil
        }
        if TypeSymbol.RequiresSymbolicProjection(function.Type) {
            if binderCtx.References.MapClrTypeToReferences(typeof(object)) is not{} objectClr {
                return nil
            }
            let erasedTask = openTask.MakeGenericType(objectClr)
            return ImportedTypeSymbol.GetConstructed(erasedTask, openTask, ImmutableArray.Create(function.Type))
        }
        if Expressions?.GetEffectiveArgumentClrTypeForOverloadResolution(function.Type) is not{} elementClr {
            return nil
        }
        let closedTask = openTask.MakeGenericType(elementClr)
        return ImportedTypeSymbol.GetConstructed(closedTask, openTask, ImmutableArray.Create(function.Type))
    }

    private func MemberType(candidate Symbol) TypeSymbol? {
        switch candidate {
            case field is FieldSymbol {
                return field.Type
            }
            case property is PropertySymbol {
                return property.Type
            }
            case function is FunctionSymbol {
                return ObservableCallResultType(function)
            }
            case declaredEvent is EventSymbol {
                return declaredEvent.Type
            }
            default {
                return nil
            }
        }
    }

    private func IsVisibleClrStepMember(member MemberInfo) bool {
        let includeInternal = binderCtx.References.CanAccessInternalMembers(member.DeclaringType?.Assembly)
        switch member {
            case field is FieldInfo {
                return ClrMemberVisibility.IsVisible(field, includeInternal)
            }
            case property is PropertyInfo {
                return ClrMemberVisibility.GetVisibleGetter(property, includeInternal) != nil
            }
            case method is MethodInfo {
                return !method.IsPrivate &&
                    (
                    ClrMemberVisibility.IsVisible(method, includeInternal) ||
                        (
                        Expressions?.GetFamilyAccessBase() != nil && ClrMemberVisibility.IsVisibleFromDerived(
                            method,
                            includeInternal
                        )
                    )
                )
            }
            default {
                return false
            }
        }
    }

    // The CLR form of a step. [`definition`](paramref) is the open definition of an imported generic type whose
    // type arguments are [`arguments`](paramref); a member type that is one of its type parameters is the argument.
    private func AddClrStepTypes(
        type Type,
        step RegionReceiverStep,
        arguments ImmutableArray[TypeSymbol],
        definition Type?,
        next List[ReceiverType]
    ) int32 {
        if ReflectionType(type) is not{} reflected {
            return StepUnresolved
        }
        let reflectedDefinition = if object.ReferenceEquals(reflected, type) {
            definition
        } else {
            reflected
        }
        try {
            return AddClrStepTypesCore(reflected, step, arguments, reflectedDefinition, next)
        } catch (ex NotSupportedException) {
            return StepUnresolved
        }
    }

    private func AddClrStepTypesCore(
        type Type,
        step RegionReceiverStep,
        arguments ImmutableArray[TypeSymbol],
        definition Type?,
        next List[ReceiverType]
    ) int32 {
        // Accessible public and friend-internal members can be named after a dot or indexed; an explicit interface
        // implementation cannot.
        let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
        let searched = List[Type]()
        searched.Add(type)
        if type.IsInterface {
            searched.AddRange(type.GetInterfaces())
            searched.Add(typeof(object))
        }
        switch step.Kind {
            case RegionReceiverStepKind.Element {
                if type.IsArray && type.GetElementType() is {} arrayElement {
                    return Outcome(AddClrType(arrayElement, arguments, definition, next))
                }
                for contract in searched {
                    if contract.IsGenericType && contract.GetGenericTypeDefinition()
                        .FullName == "System.Collections.Generic.IEnumerable`1" {
                        return Outcome(AddClrType(contract.GetGenericArguments()[0], arguments, definition, next))
                    }
                }
                for contract in type.GetInterfaces() {
                    if contract.IsGenericType && contract.GetGenericTypeDefinition()
                        .FullName == "System.Collections.Generic.IEnumerable`1" {
                        return Outcome(AddClrType(contract.GetGenericArguments()[0], arguments, definition, next))
                    }
                }
                return StepUnresolved
            }
            case RegionReceiverStepKind.Index {
                if type.IsArray && type.GetElementType() is {} arrayElement {
                    return Outcome(AddClrType(arrayElement, arguments, definition, next))
                }
                var found = false
                for searchedType in searched {
                    for property in searchedType.GetProperties(flags) {
                        if property.GetIndexParameters().Length > 0 && IsVisibleClrStepMember(property) {
                            found = true
                            if !AddClrType(property.PropertyType, arguments, definition, next) {
                                return StepUnresolved
                            }
                        }
                    }
                }
                return if found {
                    StepFound
                } else {
                    StepAbsent
                }
            }
            default {
                var found = false
                for searchedType in searched {
                    for clrMember in searchedType.GetMember(step.Name ?? "", flags) {
                        if !IsVisibleClrStepMember(clrMember) {
                            continue
                        }
                        var memberType Type? = nil
                        if step.Kind == RegionReceiverStepKind.Member {
                            if clrMember is FieldInfo field {
                                memberType = field.FieldType
                            } else if clrMember is PropertyInfo property && property.GetIndexParameters().Length == 0 {
                                memberType = property.PropertyType
                            }
                        } else if clrMember is MethodInfo method {
                            memberType = method.ReturnType
                        }
                        if memberType != nil {
                            found = true
                            if !AddClrType(memberType, arguments, definition, next) {
                                return StepUnresolved
                            }
                        }
                    }
                }
                if step.Kind == RegionReceiverStepKind.Call {
                    for method in CollectClrCandidateMethods(
                        type,
                        step.Name ?? "",
                        staticAccess: false,
                        allowProtectedInherited: Expressions?.GetFamilyAccessBase() != nil
                    ) {
                        found = true
                        if !AddClrType(method.ReturnType, arguments, definition, next) {
                            return StepUnresolved
                        }
                    }
                }
                return if found {
                    StepFound
                } else {
                    StepAbsent
                }
            }
        }
    }

    // Adds a CLR member type: a type parameter of the definition is its type argument; another open type does not
    // resolve.
    private func AddClrType(
        type Type,
        arguments ImmutableArray[TypeSymbol],
        definition Type?,
        next List[ReceiverType]
    ) bool {
        if type.IsGenericParameter {
            let owner = type.DeclaringType?.FullName
            if definition == nil ||
                type.DeclaringMethod != nil ||
                owner != definition.FullName ||
                type.GenericParameterPosition >= arguments.Length {
                return false
            }
            return AddSymbolType(arguments[type.GenericParameterPosition], next)
        }
        if type.ContainsGenericParameters || type.FullName == "System.Void" {
            return false
        }
        next.Add(ReceiverType(nil, type))
        return true
    }

    // Whether a bare name binds to a static field (not a constant) or a static property whose owner runs user code
    // in its initializer at a static member access.
    private func BareStaticOwnerInitializes(symbol Symbol?) bool {
        switch symbol {
            case field is ImplicitStaticFieldVariableSymbol {
                return !field
                    .Field
                    .IsConst &&
                    field.StructType is {} owner &&
                    TypeInitializationRunsUserCode(owner, true)
            }
            case property is ImplicitStaticPropertyVariableSymbol {
                return TypeInitializationRunsUserCode(property.StructType, true)
            }
            default {
                return false
            }
        }
    }

    private var inOperatorsRunUserCode bool = false

    // Whether an operator of the region can be user code: an operand whose type does not resolve, is not built in or
    // is `object`, a unary operator that is not predefined for its operand (after `char` promotion, as the
    // expression binder does), or a binary operator that is not predefined and has an extension operator.
    // For a fact on by-reference storage ([`forReferenceStorage`](paramref)), a source operator (of a type of the
    // package or an extension operator) is a plain call that ADR-0208 A3 exempts, as on main; an imported operator is
    // not.
    private func OperatorsRunUserCode(effects RegionEffects, forReferenceStorage bool) bool {
        let savedInOperators = inOperatorsRunUserCode
        inOperatorsRunUserCode = true
        try {
            return OperatorsRunUserCodeCore(effects, forReferenceStorage)
        } finally {
            inOperatorsRunUserCode = savedInOperators
        }
    }

    private func OperatorsRunUserCodeCore(effects RegionEffects, forReferenceStorage bool) bool {
        let enumTypes = List[EnumSymbol]()
        for candidate in effects.Operators {
            for operand in candidate.Operands {
                if operand != nil &&
                    BuiltInOperandType(operand, effects) is EnumSymbol enumOperand &&
                    !enumTypes.Contains(enumOperand) {
                    enumTypes.Add(enumOperand)
                }
            }
        }
        for candidate in effects.Operators {
            // A known built-in operand type, or `nil` for an operand that is itself an operator expression.
            let operandTypes = List[TypeSymbol?]()
            for var index = 0; index < candidate.Operands.Count; index++ {
                let operand = candidate.Operands[index]
                if operand == nil {
                    if !candidate.OperatorForms[index] {
                        return true
                    }
                    operandTypes.Add(nil)
                } else if BuiltInOperandType(operand, effects) is {} operandType {
                    operandTypes.Add(operandType)
                } else if !forReferenceStorage || OperandIsImportedType(operand, effects) {
                    return true
                } else {
                    operandTypes.Add(nil)
                }
            }
            if operandTypes.Count == 1 {
                if operandTypes[0] is not{} operandType {
                    if !forReferenceStorage && OperatorNames.TryGetUnaryName(candidate.Kind) is {} unaryName &&
                        HasAnyBuiltInOrEnumExtensionOperator(unaryName, enumTypes) {
                        return true
                    }
                    continue
                }
                var promotedType = operandType
                if ExpressionBinder.TryGetPromotedCharUnaryType(candidate.Kind, operandType, out var promoted) &&
                    promoted != nil {
                    promotedType = promoted
                }
                if !forReferenceStorage && BoundUnaryOperator.Bind(candidate.Kind, promotedType) == nil {
                    return true
                }
            } else if !forReferenceStorage &&
                !IsPredefinedBinary(candidate.Kind, operandTypes[0], operandTypes[1]) &&
                HasExtensionOperator(candidate.Kind, operandTypes[0], operandTypes[1], enumTypes) {
                return true
            }
        }
        return false
    }

    private func HasAnyBuiltInOrEnumExtensionOperator(name string, enumTypes List[EnumSymbol]) bool {
        for builtin in BuiltInTypes() {
            if $scope.TryLookupExtensionFunction(builtin, name, out _) {
                return true
            }
        }
        for enumType in enumTypes {
            if $scope.TryLookupExtensionFunction(enumType, name, out _) {
                return true
            }
        }
        return false
    }

    // Whether an operand resolves to an imported type that is not built in, whose operators are imported methods. An
    // operand that does not resolve (a generic call result such as `Pick(token)`) can have such a type, so it counts
    // (coordinator decision 2026-11-01: what the walker cannot resolve can run user code).
    private func OperandIsImportedType(operand RegionReceiverPath, effects RegionEffects) bool {
        if ResolveReceiverPath(operand, effects) is not{} types {
            return true
        }
        for type in types {
            let symbol = if type.Clr is {} clr {
                BuiltInType(clr.FullName)
            } else {
                type.Symbol
            }
            if symbol == nil && type.Clr != nil {
                return true
            }
            if symbol is not StructSymbol && symbol is not EnumSymbol && symbol != nil && !MetadataTypeKeys.IsBuiltIn(
                symbol
            ) {
                return true
            }
        }
        return false
    }

    private func IsPredefinedBinary(kind SyntaxKind, left TypeSymbol?, right TypeSymbol?) bool {
        if left == nil || right == nil {
            return false
        }
        return BoundBinaryOperator.Bind(kind, left, right) != nil
    }

    private func HasExtensionOperator(
        kind SyntaxKind,
        left TypeSymbol?,
        right TypeSymbol?,
        enumTypes List[EnumSymbol]
    ) bool {
        if OperatorNames.TryGetBinaryName(kind) is not{} name {
            return false
        }
        if left != nil {
            if $scope.TryLookupExtensionFunction(left, name, out _) {
                return true
            }
        } else if HasAnyBuiltInOrEnumExtensionOperator(name, enumTypes) {
            return true
        }
        if right != nil {
            if $scope.TryLookupExtensionFunction(right, name, out _) {
                return true
            }
        } else if HasAnyBuiltInOrEnumExtensionOperator(name, enumTypes) {
            return true
        }
        return false
    }

    // The one built-in type of an operand, or `nil` when it does not resolve to one.
    // The built-in type of an operand, or `nil` when it does not resolve to one. Candidates of several built-in types
    // (the overloads of `Math.Max`) give the first, since each has the same operators by kind.
    private func BuiltInOperandType(operand RegionReceiverPath, effects RegionEffects) TypeSymbol? {
        if (operand.Steps.Length > 0 && (effects.ContainsMemberTypeTest || HasEntryMemberTypeTest())) ||
            HasTypeTestOnReceiver(operand, effects) ||
            ResolveReceiverPath(operand, effects) is not{} types ||
            types.Count == 0 {
            return nil
        }
        var first TypeSymbol? = nil
        for candidate in types {
            let type = if candidate.Clr is {} clr {
                BuiltInType(clr.FullName)
            } else {
                candidate.Symbol
            }
            if type == nil || (!MetadataTypeKeys.IsBuiltIn(type) && type !is EnumSymbol) || object.Equals(
                type,
                TypeSymbol.Object
            ) {
                return nil
            }
            first ??= type
        }
        return first
    }

    private func BuiltInType(clrName string?) TypeSymbol? {
        for builtin in BuiltInTypes() {
            if builtin.ClrType?.FullName == clrName {
                return builtin
            }
        }
        return nil
    }

    private func BuiltInTypes()[]TypeSymbol -> []TypeSymbol{
        TypeSymbol.Bool,
        TypeSymbol.UInt8,
        TypeSymbol.Int8,
        TypeSymbol.Int16,
        TypeSymbol.UInt16,
        TypeSymbol.Int32,
        TypeSymbol.UInt32,
        TypeSymbol.Int64,
        TypeSymbol.UInt64,
        TypeSymbol.NInt,
        TypeSymbol.NUInt,
        TypeSymbol.Float32,
        TypeSymbol.Float64,
        TypeSymbol.Decimal,
        TypeSymbol.Char,
        TypeSymbol.String,
        TypeSymbol.Object
    }

    // Whether a conversion site can run a user-defined or imported conversion operator (the predicate of the
    // conversion classifier, `HasUserDefinedConversion`). A site that the walker cannot follow can.
    private func ConversionsRunUserCode(effects RegionEffects) bool {
        for conversion in effects.Conversions {
            if conversion.OperatorArms {
                if OperatorsRunUserCode(effects, false) {
                    return true
                }
                continue
            }
            let targetPath = conversion.Target
            if targetPath == nil {
                return true
            }
            if conversion.SourceIsNil {
                if !NilReachesTargetWithoutOperator(targetPath, effects) {
                    return true
                }
                continue
            }
            let targets = ConversionTypes(targetPath, effects)
            if targets == nil {
                return true
            }
            let sourcePath = conversion.Source
            if sourcePath == nil {
                // An operator or a literal of built-in operands converts only to a type that is not built in. An
                // operator of the region that is user-defined, an extension, or has an operand that does not resolve
                // may return another type (coordinator decision 2026-11-01).
                if !conversion.SourceIsBuiltInByForm || OperatorsRunUserCode(effects, false) {
                    return true
                }
                for target in targets {
                    if !MetadataTypeKeys.IsBuiltIn(StripNullableValue(target)) {
                        return true
                    }
                }
                continue
            }
            let sources = ConversionTypes(sourcePath, effects)
            if sources == nil {
                return true
            }
            // A generic target type resolves to its definition here, which no conversion operator names, so a
            // value of another type converted to it may call one.
            if targetPath.RootType?.HasTypeArguments == true && targetPath.Steps.Length == 0 {
                return true
            }
            for source in sources {
                for target in targets {
                    // Between built-in types the conversion is predefined (numeric, boxing or identity).
                    if object.Equals(source, target) ||
                        (
                        MetadataTypeKeys.IsBuiltIn(StripNullableValue(source)) && MetadataTypeKeys.IsBuiltIn(
                            StripNullableValue(target)
                        )
                    ) {
                        continue
                    }
                    if ConversionOperatorReaches(source, target, conversion.AllowExplicit) {
                        return true
                    }
                }
            }
        }
        return false
    }

    // Whether a call or an index access of the region can pass a value through a user-defined or imported conversion
    // operator (ADR-0213 §20b, one conservative rule). Every candidate of the callee's name, or every indexer of the
    // target, with the receiver's type arguments substituted, is checked, whichever the binder selects. A call that
    // the walker cannot check counts (coordinator decision 2026-11-01): a callee whose candidates it cannot list, a
    // named argument, an argument without a path, an operator argument when an operator of the region can return
    // another type, or a range that does not slice a built-in sequence.
    private func ArgumentsRunUserConversion(effects RegionEffects) bool {
        let operatorResultsKnown = !OperatorsRunUserCode(effects, false)
        for call in effects.Calls {
            if CallArgumentsRunUserConversion(call, effects, operatorResultsKnown) {
                return true
            }
        }
        return IndexArgumentsRunUserConversion(effects, operatorResultsKnown)
    }

    private func IndexArgumentsRunUserConversion(effects RegionEffects, operatorResultsKnown bool) bool {
        for access in effects.IndexAccesses {
            if CallArgumentsRunUserConversion(access, effects, operatorResultsKnown) {
                return true
            }
        }
        // An index in a constant pattern of a variable or a call is an index access; one of a type name is a
        // generic type (`o is List[int32]`).
        for access in effects.PatternIndexAccesses {
            if access.Receiver is {} target &&
                (
                target.RootIsCall ||
                    target.RootType != nil ||
                    target.RootName is {} root &&
                    TryLookupRegionVariableType(root) != nil
            ) &&
                CallArgumentsRunUserConversion(access, effects, operatorResultsKnown) {
                return true
            }
        }
        return false
    }

    private const ArgumentSkipped int32 = 0
    private const ArgumentBuiltIn int32 = 1
    private const ArgumentTyped int32 = 2
    private const ArgumentNil int32 = 3
    private const ArgumentByReference int32 = 4
    private const ArgumentFunction int32 = 5
    private const ArgumentInlineDeclaration int32 = 6
    private const ArgumentReadOnlyReference int32 = 7

    private func CallArgumentsRunUserConversion(
        call RegionCall,
        effects RegionEffects,
        operatorResultsKnown bool
    ) bool {
        if call
            .Arguments
            .Count == 0 ||
            (call.Kind != RegionCallKind.NamedInvocation && call.Kind != RegionCallKind.MemberInvocation) {
            return false
        }
        if call.CalleeName is not{} name {
            return true
        }
        if !TryBuildCallArgumentInfo(
            call.Arguments,
            call.ArgumentForms,
            call.Syntax,
            effects,
            operatorResultsKnown,
            out var argumentTypes,
            out var overloadArgumentTypes,
            out var kinds
        ) {
            return true
        }
        // Issue #5662: when every argument has a resolved type, `out var` or `nil`, use the binder's own overload
        // resolution (OverloadResolver and ClrOverloadResolution) to select the candidate and substitute its type
        // arguments on each receiver alternative.
        if name != RegionEffectScanner.IndexMemberName &&
            CanResolveOverloadArguments(overloadArgumentTypes, kinds) &&
            TryResolveCallArgumentsRunUserConversion(
            call,
            name,
            effects,
            overloadArgumentTypes,
            kinds,
            out var runsConversion
        ) {
            return runsConversion
        }
        // Fallback for index accesses and calls with unresolved, untyped operator or function-literal arguments.
        guard let candidates = CandidateParameterLists(call, name, effects, argumentTypes.Count) else {
            return true
        }
        if candidates.Count == 0 {
            return true
        }
        for parameters in candidates {
            for var index = 0; index < parameters.Count; index++ {
                if !ArgumentPassesWithoutCode(parameters[index], argumentTypes[index], kinds[index]) {
                    return true
                }
            }
        }
        return false
    }

    private func TryBuildCallArgumentInfo(
        arguments List[RegionReceiverPath?],
        argumentForms List[RegionArgumentForm],
        callSyntax CallExpressionSyntax?,
        effects RegionEffects,
        operatorResultsKnown bool,
        out argumentTypes List[List[TypeSymbol]?],
        out overloadArgumentTypes List[List[TypeSymbol]?],
        out kinds List[int32]
    ) bool {
        argumentTypes = List[List[TypeSymbol]?]()
        overloadArgumentTypes = List[List[TypeSymbol]?]()
        kinds = List[int32]()
        for var index = 0; index < arguments.Count; index++ {
            let form = argumentForms[index]
            if form == RegionArgumentForm.Named {
                return false
            }
            let argSyntax = if callSyntax != nil && index < callSyntax.Arguments.Count {
                callSyntax.Arguments[index]
            } else {
                default(ExpressionSyntax?)
            }
            if form == RegionArgumentForm.ByReference || form == RegionArgumentForm.ReadOnlyReference {
                let storageTypes = StorageTypes(arguments[index], argSyntax, effects)
                argumentTypes.Add(storageTypes)
                overloadArgumentTypes.Add(storageTypes)
                kinds.Add(
                    if form == RegionArgumentForm.ReadOnlyReference {
                        ArgumentReadOnlyReference
                    } else {
                        ArgumentByReference
                    }
                )
            } else if form == RegionArgumentForm.FunctionLiteral {
                argumentTypes.Add(nil)
                overloadArgumentTypes.Add(nil)
                kinds.Add(ArgumentFunction)
            } else if form == RegionArgumentForm.InlineDeclaration {
                if arguments[index] is {} path {
                    let storageTypes = StorageTypes(path, argSyntax, effects)
                    argumentTypes.Add(storageTypes)
                    overloadArgumentTypes.Add(storageTypes)
                    kinds.Add(ArgumentByReference)
                } else {
                    argumentTypes.Add(nil)
                    overloadArgumentTypes.Add(nil)
                    kinds.Add(ArgumentInlineDeclaration)
                }
            } else if form == RegionArgumentForm.Range {
                argumentTypes.Add(nil)
                overloadArgumentTypes.Add(nil)
                kinds.Add(ArgumentSkipped)
            } else if form == RegionArgumentForm.StringByForm {
                if !operatorResultsKnown {
                    return false
                }
                let text = List[TypeSymbol]()
                text.Add(TypeSymbol.String)
                argumentTypes.Add(text)
                overloadArgumentTypes.Add(text)
                kinds.Add(ArgumentTyped)
            } else if form == RegionArgumentForm.Nil {
                argumentTypes.Add(nil)
                overloadArgumentTypes.Add(nil)
                kinds.Add(ArgumentNil)
            } else if form == RegionArgumentForm.BuiltInByForm {
                if !operatorResultsKnown {
                    return false
                }
                argumentTypes.Add(nil)
                overloadArgumentTypes.Add(nil)
                kinds.Add(ArgumentBuiltIn)
            } else {
                if arguments[index] is not{} path || path.RootType?.HasTypeArguments == true && path.Steps.Length == 0 {
                    return false
                }
                if ConversionTypes(path, effects) is not{} types || types.Count == 0 {
                    return false
                }
                let asserted = HasTrailingNullAssertion(argSyntax)
                if asserted {
                    for var typeIndex = 0; typeIndex < types.Count; typeIndex++ {
                        types[typeIndex] = StripAllNullability(types[typeIndex]) ?? types[typeIndex]
                    }
                }
                argumentTypes.Add(types)
                overloadArgumentTypes.Add(OverloadValueTypes(path, asserted, effects))
                kinds.Add(ArgumentTyped)
            }
        }
        return true
    }

    private func CanResolveOverloadArguments(argumentTypes List[List[TypeSymbol]?], kinds List[int32]) bool {
        if Overloads == nil || Expressions == nil {
            return false
        }
        var combinations = 1
        for var i = 0; i < kinds.Count; i++ {
            let kind = kinds[i]
            if kind == ArgumentNil || kind == ArgumentInlineDeclaration {
                continue
            }
            if kind != ArgumentTyped && kind != ArgumentByReference && kind != ArgumentReadOnlyReference {
                return false
            }
            if argumentTypes[i] is not{} types || types.Count == 0 {
                return false
            }
            combinations = combinations * types.Count
            if combinations > MaxReceiverTypes {
                return false
            }
        }
        return true
    }

    private func BuildArgumentTypeCombinations(argumentTypes List[List[TypeSymbol]?], kinds List[int32]) List[
        List[TypeSymbol?]
    ]? {
        var combinations = List[List[TypeSymbol?]]()
        combinations.Add(List[TypeSymbol?]())
        for var i = 0; i < kinds.Count; i++ {
            let next = List[List[TypeSymbol?]]()
            if kinds[i] == ArgumentNil || kinds[i] == ArgumentInlineDeclaration {
                for prefix in combinations {
                    let extended = List[TypeSymbol?](prefix)
                    extended.Add(nil)
                    next.Add(extended)
                }
            } else {
                if argumentTypes[i] is not{} types || types.Count == 0 {
                    return nil
                }
                for prefix in combinations {
                    for type in types {
                        let extended = List[TypeSymbol?](prefix)
                        extended.Add(type)
                        next.Add(extended)
                    }
                }
            }
            if next.Count > MaxReceiverTypes {
                return nil
            }
            combinations = next
        }
        return combinations
    }

    private func TryBuildSyntheticBoundArguments(
        combination List[TypeSymbol?],
        kinds List[int32],
        callArguments List[RegionReceiverPath?],
        callSyntax CallExpressionSyntax?,
        effects RegionEffects,
        out boundArguments ImmutableArray[BoundExpression]
    ) bool {
        boundArguments = default(ImmutableArray[BoundExpression])
        let builder = ImmutableArray.CreateBuilder[BoundExpression](combination.Count)
        for var i = 0; i < combination.Count; i++ {
            let argSyntax = if callSyntax != nil && i < callSyntax.Arguments.Count {
                callSyntax.Arguments[i]
            } else {
                default(ExpressionSyntax?)
            }
            let kind = kinds[i]
            if kind == ArgumentNil {
                builder.Add(BoundLiteralExpression(argSyntax, nil))
            } else if kind == ArgumentInlineDeclaration {
                builder.Add(BoundAddressOfExpression(argSyntax, BoundErrorExpression(argSyntax), false, false))
            } else if kind == ArgumentByReference {
                let storageType = combination[i]!!
                builder.Add(
                    BoundAddressOfExpression(argSyntax, BoundDefaultExpression(argSyntax, storageType), false, false)
                )
            } else if kind == ArgumentReadOnlyReference {
                let storageType = combination[i]!!
                builder.Add(
                    BoundAddressOfExpression(argSyntax, BoundDefaultExpression(argSyntax, storageType), false, true)
                )
            } else {
                let argType = combination[i]!!
                var unwrapped ExpressionSyntax? = argSyntax
                while unwrapped is ParenthesizedExpressionSyntax parenthesized {
                    unwrapped = parenthesized.Expression
                }
                if unwrapped is LiteralExpressionSyntax literal && literal.Value != nil {
                    builder.Add(BoundLiteralExpression(literal, literal.Value))
                } else if ExpressionBinder.IsIntegerType(argType) {
                    if !TryBuildIntegerBoundArgument(
                        argSyntax,
                        unwrapped,
                        argType,
                        if i < callArguments.Count {
                            callArguments[i]
                        } else {
                            default(RegionReceiverPath?)
                        },
                        effects,
                        out var intArg
                    ) {
                        return false
                    }
                    builder.Add(intArg!!)
                } else {
                    builder.Add(BoundDefaultExpression(argSyntax, argType))
                }
            }
        }
        boundArguments = builder.MoveToImmutable()
        return true
    }

    private func HasEnclosingDeclaration(node SyntaxNode?, name string, constOnly bool) bool {
        for var current SyntaxNode? = node; current != nil; current = current?.Parent {
            if current is BlockStatementSyntax block {
                for statement in block.Statements {
                    if statement is VariableDeclarationSyntax declaration &&
                        declaration
                        .Identifier
                        .ValueText == name &&
                        (!constOnly || declaration.Keyword?.Kind == SyntaxKind.ConstKeyword) {
                        return true
                    }
                }
            }
            if RegionEffectKindTable.Classify(current.Kind) == RegionEffectClass.Loop {
                break
            }
        }
        return false
    }

    private func TryBuildIntegerBoundArgument(
        argSyntax ExpressionSyntax?,
        unwrapped ExpressionSyntax?,
        argType TypeSymbol,
        argPath RegionReceiverPath?,
        effects RegionEffects,
        out boundArg BoundExpression?
    ) bool {
        boundArg = nil
        switch unwrapped {
            case DefaultExpressionSyntax {
                boundArg = BoundDefaultExpression(argSyntax, argType)
                return true
            }
            case nameExpr is NameExpressionSyntax {
                let ident = nameExpr.IdentifierToken.ValueText
                if HasEnclosingDeclaration(argSyntax, ident, constOnly: true) {
                    return false
                }
                if argPath == nil ||
                    argPath
                    .Steps
                    .Length > 0 ||
                    argPath.RootIsCall ||
                    argPath.RootType != nil ||
                    argPath.RootName != ident ||
                    HasEnclosingDeclaration(argSyntax, ident, constOnly: false) {
                    boundArg = BoundDefaultExpression(argSyntax, argType)
                    return true
                }
                switch $scope.TryLookupSymbol(ident) {
                    case global is GlobalVariableSymbol when global.IsConst {
                        if global.ConstantValue == nil {
                            return false
                        }
                        boundArg = BoundVariableExpression(argSyntax, global)
                        return true
                    }
                    case localConst is LocalVariableSymbol when localConst.IsConst {
                        if localConst.ConstantValue == nil {
                            return false
                        }
                        boundArg = BoundVariableExpression(argSyntax, localConst)
                        return true
                    }
                    case staticField is ImplicitStaticFieldVariableSymbol when staticField.Field.IsConst {
                        if !staticField.Field.HasConstantValue || staticField.Field.ConstantValue == nil {
                            return false
                        }
                        boundArg = BoundFieldAccessExpression(argSyntax, nil, staticField.StructType, staticField.Field)
                        return true
                    }
                    case VariableSymbol {
                        boundArg = BoundDefaultExpression(argSyntax, argType)
                        return true
                    }
                    default {
                        return false
                    }
                }
            }
            case IndexExpressionSyntax {
                boundArg = BoundDefaultExpression(argSyntax, argType)
                return true
            }
            case callExpr is CallExpressionSyntax {
                if argPath?.RootType != nil || callExpr.ConversionTypeClause != nil {
                    return false
                }
                boundArg = BoundDefaultExpression(argSyntax, argType)
                return true
            }
            default {
                guard let path = argPath else {
                    return false
                }
                if path
                    .Steps
                    .Length == 1 &&
                    path
                    .Steps[0]
                    .Kind == RegionReceiverStepKind.Member &&
                    !path.RootIsCall &&
                    path.RootType == nil &&
                    path.RootName is {} rootName {
                    if !HasEnclosingDeclaration(argSyntax, rootName, constOnly: false) &&
                        ResolveTypeName(rootName) is StructSymbol owner {
                        if TypeMemberModel.TryGetStaticFieldIncludingInherited(
                            owner,
                            path.Steps[0].Name ?? "",
                            out var field,
                            out _
                        ) &&
                            field is {} constField &&
                            constField
                            .IsConst {
                            if !constField.HasConstantValue || constField.ConstantValue == nil {
                                return false
                            }
                            boundArg = BoundFieldAccessExpression(argSyntax, nil, owner, constField)
                            return true
                        }
                    }
                }
                return false
            }
        }
    }

    private func TryResolveCallExplicitTypeArguments(
        callSyntax CallExpressionSyntax?,
        out explicitTypeArguments ImmutableArray[TypeSymbol]
    ) bool {
        explicitTypeArguments = default(ImmutableArray[TypeSymbol])
        if callSyntax?.TypeArgumentList is not{} list {
            return true
        }
        let builder = ImmutableArray.CreateBuilder[TypeSymbol](list.Arguments.Count)
        for clause in list.Arguments {
            if clause.HasTypeArguments || ResolveTypeClause(clause) is not{} resolved {
                return false
            }
            builder.Add(
                if clause.QuestionToken != nil {
                    NullableTypeSymbol.Get(resolved)
                } else {
                    resolved
                }
            )
        }
        explicitTypeArguments = builder.MoveToImmutable()
        return true
    }

    private func TryResolveExplicitClrMethodTypeArgs(
        callSyntax CallExpressionSyntax?,
        out explicitTypeArgs[]?Type,
        out explicitTypeArgSymbols ImmutableArray[TypeSymbol]
    ) bool {
        explicitTypeArgs = nil
        if !TryResolveCallExplicitTypeArguments(callSyntax, out explicitTypeArgSymbols) {
            return false
        }
        if explicitTypeArgSymbols.IsDefaultOrEmpty {
            return true
        }
        let resolved = [explicitTypeArgSymbols.Length]Type
        for var i = 0; i < explicitTypeArgSymbols.Length; i++ {
            let symbol = explicitTypeArgSymbols[i]
            if symbol.ClrType is {} clr && binderCtx.References.MapClrTypeToReferences(clr) is {} mapped {
                resolved[i] = mapped
            } else if symbol !is EnumSymbol && MemberLookup.TryProjectErasedClrType(symbol, out var erased) &&
                binderCtx
                .References
                .MapClrTypeToReferences(erased) is {} mappedErased {
                resolved[i] = mappedErased
            } else {
                resolved[i] = binderCtx.References.GetCoreType("System.Object")
            }
        }
        explicitTypeArgs = resolved
        return true
    }

    private func TryResolveCallArgumentsRunUserConversion(
        call RegionCall,
        name string,
        effects RegionEffects,
        argumentTypes List[List[TypeSymbol]?],
        kinds List[int32],
        out runsConversion bool
    ) bool {
        runsConversion = true
        guard let combinations = BuildArgumentTypeCombinations(argumentTypes, kinds) else {
            return false
        }
        if call.Kind == RegionCallKind.NamedInvocation {
            let functions = $scope.TryLookupFunctions(name)
            if functions.IsDefaultOrEmpty {
                return false
            }
            return TryResolveSourceCallRunsUserConversion(
                functions,
                nil,
                call,
                effects,
                combinations,
                kinds,
                out runsConversion
            )
        }
        var receivers List[ReceiverType]? = nil
        if call.ReceiverName is {} receiverName {
            let types = List[ReceiverType]()
            if AddRootTypes(receiverName, false, effects, types) {
                receivers = types
            }
        } else if call.Receiver is {} path {
            receivers = ResolveReceiverPath(path, effects)
        }
        guard let resolved = receivers else {
            return false
        }
        let staticAccess = ReceiverNamesType(call)
        var anyReceiverApplies = false
        var allReceiversResolved = true
        for receiver in resolved {
            if !TryResolveReceiverCallRunsUserConversion(
                receiver,
                name,
                staticAccess,
                call,
                effects,
                combinations,
                kinds,
                out var receiverApplies,
                out var receiverRunsConversion
            ) {
                allReceiversResolved = false
                continue
            }
            if receiverRunsConversion {
                runsConversion = true
                return true
            }
            anyReceiverApplies = anyReceiverApplies || receiverApplies
        }
        if !allReceiversResolved || !anyReceiverApplies {
            return false
        }
        runsConversion = false
        return true
    }

    private func TryResolveSourceCallRunsUserConversion(
        methods ImmutableArray[FunctionSymbol],
        receiverType TypeSymbol?,
        call RegionCall,
        effects RegionEffects,
        combinations List[List[TypeSymbol?]],
        kinds List[int32],
        out runsConversion bool
    ) bool {
        runsConversion = true
        if Overloads == nil || !TryResolveCallExplicitTypeArguments(call.Syntax, out var explicitTypeArguments) {
            return false
        }
        var allResolved = true
        for combination in combinations {
            if !TryBuildSyntheticBoundArguments(
                combination,
                kinds,
                call.Arguments,
                call.Syntax,
                effects,
                out var boundArgs
            ) ||
                !Overloads!!
                .TryResolveLoopCallParameters(
                methods,
                boundArgs,
                call.Syntax,
                receiverType,
                explicitTypeArguments,
                out var parameters
            ) {
                allResolved = false
                continue
            }
            if !ResolvedParametersPassWithoutCode(parameters, combination, kinds) {
                runsConversion = true
                return true
            }
        }
        runsConversion = false
        return allResolved
    }

    private func ResolvedParametersPassWithoutCode(
        parameters List[TypeSymbol],
        combination List[TypeSymbol?],
        kinds List[int32]
    ) bool {
        if parameters.Count != combination.Count {
            return false
        }
        for var i = 0; i < parameters.Count; i++ {
            let kind = kinds[i]
            if (parameters[i] is ByRefTypeSymbol) != (
                kind == ArgumentByReference || kind == ArgumentInlineDeclaration
            ) {
                return false
            }
            let types = if combination[i] is {} argType {
                List[TypeSymbol]{argType}
            } else {
                default(List[TypeSymbol]?)
            }
            if !ArgumentPassesWithoutCode(parameters[i], types, kind) {
                return false
            }
        }
        return true
    }

    private func HasDefaultInterfaceMethod(declared StructSymbol, name string) bool {
        for current in declared.GetHierarchy() {
            for iface in current.Interfaces {
                if iface == nil {
                    continue
                }
                for method in TypeMemberModel.GetMethods(iface, name, MemberQuery.Instance(MemberKinds.Method)) {
                    if InterfaceSymbol.HasDefaultBody(method) {
                        return true
                    }
                }
            }
        }
        return false
    }

    private func TryResolveReceiverCallRunsUserConversion(
        receiver ReceiverType,
        name string,
        staticAccess bool,
        call RegionCall,
        effects RegionEffects,
        combinations List[List[TypeSymbol?]],
        kinds List[int32],
        out receiverApplies bool,
        out runsConversion bool
    ) bool {
        receiverApplies = false
        runsConversion = false
        switch receiver.Symbol {
            case declared is StructSymbol {
                let query = if staticAccess {
                    MemberQuery.InheritedStatic(MemberKinds.Method)
                } else {
                    MemberQuery.Instance(MemberKinds.Method)
                }
                let methods = TypeMemberModel.GetMethods(declared, name, query)
                if !methods.IsDefaultOrEmpty {
                    receiverApplies = true
                    return TryResolveSourceCallRunsUserConversion(
                        methods,
                        declared,
                        call,
                        effects,
                        combinations,
                        kinds,
                        out runsConversion
                    )
                }
                if !staticAccess &&
                    (HasDefaultInterfaceMethod(declared, name) || HasExtensionFunction(declared, name)) {
                    return false
                }
                let importedBase = declared.GetHierarchy().Last().ImportedBaseType
                if staticAccess && importedBase == nil {
                    return true
                }
                let baseClr = importedBase?.ClrType ??
                    (
                    if staticAccess {
                        default(Type?)
                    } else {
                        typeof(object)
                    }
                )
                return TryResolveClrReceiverCallRunsUserConversion(
                    baseClr,
                    importedBase,
                    name,
                    staticAccess,
                    call,
                    effects,
                    combinations,
                    kinds,
                    out receiverApplies,
                    out runsConversion,
                    ReceiverType(declared, nil),
                    allowProtectedInherited: !staticAccess && Expressions?.GetFamilyAccessBase() != nil
                )
            }
            case contract is InterfaceSymbol {
                for level in contract.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    for clrBase in level.BaseClrInterfaces {
                        if (MemberShape(clrBase, name) & MemberIsMethod) != 0 {
                            return false
                        }
                    }
                }
                let query = if staticAccess {
                    MemberQuery.InheritedStatic(MemberKinds.Method)
                } else {
                    MemberQuery.Instance(MemberKinds.Method)
                }
                let methods = TypeMemberModel.GetMethods(contract, name, query)
                if !methods.IsDefaultOrEmpty {
                    receiverApplies = true
                    return TryResolveSourceCallRunsUserConversion(
                        methods,
                        contract,
                        call,
                        effects,
                        combinations,
                        kinds,
                        out runsConversion
                    )
                }
                if !staticAccess {
                    if ExtensionMayBind(receiver, name, call.Arguments.Count) {
                        return false
                    }
                    return TryResolveClrReceiverCallRunsUserConversion(
                        typeof(object),
                        nil,
                        name,
                        staticAccess: false,
                        call,
                        effects,
                        combinations,
                        kinds,
                        out receiverApplies,
                        out runsConversion,
                        receiver,
                        allowProtectedInherited: false
                    )
                }
                return true
            }
            default {
                let symbolic = receiver.Symbol
                let clrType = receiver.Clr ?? symbolic?.ClrType
                return TryResolveClrReceiverCallRunsUserConversion(
                    clrType,
                    symbolic,
                    name,
                    staticAccess,
                    call,
                    effects,
                    combinations,
                    kinds,
                    out receiverApplies,
                    out runsConversion,
                    receiver,
                    allowProtectedInherited: false
                )
            }
        }
    }

    private func CollectClrCandidateMethods(
        reflected Type,
        name string,
        staticAccess bool,
        allowProtectedInherited bool = false
    ) List[MethodInfo] {
        if staticAccess {
            let imported = if Expressions != nil {
                Expressions!!.WithFamilyAccess(
                    ImportedClassSymbol(reflected, declaration: nil, references: $scope.References)
                )
            } else {
                ImportedClassSymbol(reflected, declaration: nil, references: $scope.References)
            }
            return imported.GetVisibleStaticCandidateMethods(name)
        }
        let canAccessInternals(Type?) -> bool = (type Type?) -> type != nil &&
            binderCtx
            .References
            .CanAccessInternalMembers(type.Assembly)
        let methods = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
            reflected,
            name,
            includeInternal: canAccessInternals(reflected),
            includeExplicitInterfaceMembers: false,
            canAccessInternals: canAccessInternals
        )
            .ToList()
        if reflected.IsInterface {
            for objectMethod in MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                typeof(object),
                name,
                includeInternal: false,
                includeExplicitInterfaceMembers: false
            ) {
                if !MemberLookup.HasSameSignature(methods, objectMethod) {
                    methods.Add(objectMethod)
                }
            }
        }
        if allowProtectedInherited && Expressions != nil {
            for protectedCandidate in Expressions!!.CollectBaseClrMethodCandidates(reflected, name) {
                if !MemberLookup.HasSameSignature(methods, protectedCandidate) {
                    methods.Add(protectedCandidate)
                }
            }
        }
        return methods
    }

    private func TryResolveClrReceiverCallRunsUserConversion(
        clrType Type?,
        symbolic TypeSymbol?,
        name string,
        staticAccess bool,
        call RegionCall,
        effects RegionEffects,
        combinations List[List[TypeSymbol?]],
        kinds List[int32],
        out receiverApplies bool,
        out runsConversion bool,
        extensionReceiver ReceiverType,
        allowProtectedInherited bool
    ) bool {
        receiverApplies = false
        runsConversion = false
        if clrType == nil || ReflectionType(clrType) is not{} reflected {
            return false
        }
        try {
            if reflected.IsInterface {
                for contract in reflected.GetInterfaces() {
                    if (ClrMemberShape(contract, name) & MemberIsMethod) != 0 {
                        return false
                    }
                }
            }
            let methods = CollectClrCandidateMethods(reflected, name, staticAccess, allowProtectedInherited)
            if methods.Count == 0 {
                if !staticAccess && ExtensionMayBind(extensionReceiver, name, call.Arguments.Count) {
                    return false
                }
                return true
            }
            receiverApplies = true
            var allResolved = true
            for combination in combinations {
                if !TryBuildSyntheticBoundArguments(
                    combination,
                    kinds,
                    call.Arguments,
                    call.Syntax,
                    effects,
                    out var boundArgs
                ) ||
                    !TryResolveClrCandidate(
                    methods,
                    symbolic,
                    call.Syntax,
                    boundArgs,
                    combination,
                    kinds,
                    staticAccess,
                    out var best,
                    out var isExpanded,
                    out var symbolicMethodTypeArgs
                ) {
                    allResolved = false
                    continue
                }
                if !ClrResolvedParametersPassWithoutCode(
                    symbolic,
                    best!!,
                    isExpanded,
                    symbolicMethodTypeArgs,
                    combination,
                    kinds,
                    call.Syntax
                ) {
                    runsConversion = true
                    return true
                }
            }
            runsConversion = false
            return allResolved
        } catch (ex NotSupportedException) {
            return false
        }
    }

    private func TryResolveClrCandidate(
        methods List[MethodInfo],
        symbolic TypeSymbol?,
        callSyntax CallExpressionSyntax?,
        boundArgs ImmutableArray[BoundExpression],
        combination List[TypeSymbol?],
        kinds List[int32],
        staticAccess bool,
        out best MethodInfo?,
        out isExpanded bool,
        out symbolicMethodTypeArgs ImmutableArray[TypeSymbol?]
    ) bool {
        best = nil
        isExpanded = false
        symbolicMethodTypeArgs = default(ImmutableArray[TypeSymbol?])
        if Expressions == nil {
            return false
        }
        if !TryResolveExplicitClrMethodTypeArgs(callSyntax, out var explicitTypeArgs, out var explicitTypeArgSymbols) {
            return false
        }
        let clrArgTypes = [combination.Count]Type?
        for var i = 0; i < combination.Count; i++ {
            let kind = kinds[i]
            if kind == ArgumentNil {
                clrArgTypes[i] = nil
                continue
            }
            if kind == ArgumentInlineDeclaration {
                clrArgTypes[i] = ClrOverloadResolution.InlineOutVarArgumentType
                continue
            }
            guard let argType = combination[i] else {
                return false
            }
            guard let argClr = Expressions!!.GetEffectiveArgumentClrTypeForOverloadResolution(argType) else {
                return false
            }
            clrArgTypes[i] = if kind == ArgumentByReference || kind == ArgumentReadOnlyReference {
                if argClr.IsByRef {
                    argClr
                } else {
                    argClr.MakeByRefType()
                }
            } else {
                argClr
            }
        }
        let symbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
            nil,
            ImmutableArray.CreateRange(boundArgs.Select((a BoundExpression) -> a.Type))
        )
        let candidateMethods = MemberLookup.ExcludeErasureOnlyEnumCandidates(
            methods,
            symbolicArgs,
            argumentNames: nil,
            symbolicReceiverType: symbolic
        )
            .ToList()
        if candidateMethods.Count == 0 {
            return false
        }
        let recoverTypeArgSymbols(MethodInfo, bool) -> ImmutableArray[TypeSymbol?] = (
            closed MethodInfo,
            expanded bool
        ) -> {
            let recovered = MemberLookup.BuildSymbolicMethodTypeArgs(
                closed,
                explicitTypeArgSymbols,
                symbolicArgs,
                expanded
            )
            return MemberLookup.ValidateSymbolicMethodConstraintsWithReceiver(symbolic, closed, recovered)
        }
        let importedReceiver = symbolic as ImportedTypeSymbol
        let interpolatedStringArgs = if callSyntax != nil {
            ExpressionBinder.ComputeInterpolatedStringArgFlags(callSyntax.Arguments, combination.Count)
        } else {
            default(IReadOnlyList[bool]?)
        }
        let resolution = ClrOverloadResolution.Resolve(
            candidateMethods,
            clrArgTypes,
            explicitTypeArgs,
            binderCtx.References.MapClrTypeToReferences,
            interpolatedStringArgs,
            recoverTypeArgSymbols: recoverTypeArgSymbols,
            supplementaryInterfaceCheck: (
                source Type,
                target Type
            ) -> ExpressionBinder.IsUserClassAssignableToInterfaceFromArgs(boundArgs, clrArgTypes, source, target),
            constantNarrowingArgumentCheck: ExpressionBinder.MakeConstantNarrowingArgumentCheck(boundArgs),
            structuralProjectionArgumentCheck: ExpressionBinder.MakeStructuralProjectionArgumentCheck(
                boundArgs,
                nativeConversions: conversions
            ),
            erasedArgumentMismatchCheck: ExpressionBinder.MakeErasedArgumentMismatchCheck(boundArgs),
            delegateArgumentCheck: ExpressionBinder.MakeDelegateArgumentCheck(boundArgs),
            explicitTypeArgIsGenuine: ClrOverloadResolution.BuildGenuineExplicitTypeArgFlags(explicitTypeArgSymbols),
            explicitTypeArgumentMismatchCheck: ExpressionBinder.MakeExplicitTypeArgumentMismatchCheck(
                boundArgs,
                explicitTypeArgSymbols
            ),
            openLiteralArgumentCheck: ExpressionBinder.MakeOpenLiteralArgumentCheck(boundArgs),
            symbolicArgTypes: symbolicArgs,
            symbolicArgumentConversionClassifier: ExpressionBinder.MakeSymbolicArgumentConversionClassifier(
                boundArgs,
                nativeConversions: conversions,
                receiverType: symbolic,
                openGenericDefinition: importedReceiver?.OpenDefinition,
                symbolicTypeArguments: importedReceiver?.TypeArguments ?? default(ImmutableArray[TypeSymbol]),
                explicitMethodTypeArguments: explicitTypeArgSymbols
            )
        )
        if resolution.Outcome != ClrOverloadResolution
            .ResolutionOutcome
            .Resolved ||
            resolution.Best is not{} resolvedMethod {
            return false
        }
        if !staticAccess && HasExtensionFunction(symbolic, resolvedMethod.Name) && boundArgs.Any(
            (a BoundExpression) -> a.Type is FunctionTypeSymbol or
                DelegateTypeSymbol ||
                a
                .Type
                ?.ClrType is {} clr &&
                ClrTypeUtilities.IsDelegateType(clr)
        ) {
            return false
        }
        if resolvedMethod.IsGenericMethod {
            let recovered = MemberLookup.BuildSymbolicMethodTypeArgs(
                resolvedMethod,
                explicitTypeArgSymbols,
                symbolicArgs,
                resolution.IsExpanded
            )
            let validated = MemberLookup.ValidateSymbolicMethodConstraintsWithReceiver(
                symbolic,
                resolvedMethod,
                recovered
            )
            if !validated.IsDefault && validated.Any(
                (t TypeSymbol?) -> t == nil || t == TypeSymbol.Error || MemberLookup.IsSymbolicInferenceConflict(t)
            ) {
                return false
            }
            symbolicMethodTypeArgs = validated
        }
        best = resolvedMethod
        isExpanded = resolution.IsExpanded
        return true
    }

    private func ClrResolvedParametersPassWithoutCode(
        symbolic TypeSymbol?,
        method MethodInfo,
        isExpanded bool,
        symbolicMethodTypeArgs ImmutableArray[TypeSymbol?],
        combination List[TypeSymbol?],
        kinds List[int32],
        callSyntax CallExpressionSyntax?
    ) bool {
        let methodParameters = method.GetParameters()
        for var i = 0; i < combination.Count; i++ {
            let kind = kinds[i]
            let types = if combination[i] is {} argType {
                List[TypeSymbol]{argType}
            } else {
                default(List[TypeSymbol]?)
            }
            if isExpanded && methodParameters.Length > 0 && i >= methodParameters.Length - 1 {
                if kind == ArgumentByReference ||
                    kind == ArgumentReadOnlyReference ||
                    kind == ArgumentInlineDeclaration {
                    return false
                }
                let paramsIndex = methodParameters.Length - 1
                let arrayType = ResolveClrParameterType(
                    symbolic,
                    method,
                    paramsIndex,
                    methodParameters[paramsIndex],
                    symbolicMethodTypeArgs
                )
                let elementType TypeSymbol? = switch StripReferenceNullability(arrayType) {
                    case slice is SliceTypeSymbol: slice.ElementType
                    case arr is ArrayTypeSymbol: arr.ElementType
                    default: default(TypeSymbol?)
                }
                if elementType == nil || !ArgumentPassesWithoutCode(elementType, types, kind) {
                    return false
                }
                continue
            }
            if i >= methodParameters.Length {
                return false
            }
            let paramInfo = methodParameters[i]
            if kind == ArgumentReadOnlyReference {
                if !paramInfo.IsIn {
                    return false
                }
            } else if kind == ArgumentByReference || kind == ArgumentInlineDeclaration {
                if !paramInfo.ParameterType.IsByRef || paramInfo.IsIn {
                    return false
                }
                if callSyntax != nil && i < callSyntax.Arguments.Count {
                    var argSyntax ExpressionSyntax = callSyntax.Arguments[i]
                    while argSyntax is ParenthesizedExpressionSyntax parenthesized {
                        argSyntax = parenthesized.Expression
                    }
                    if argSyntax is RefArgumentExpressionSyntax refArg {
                        let argRefKind = Binder.GetRefKindFromModifier(refArg.RefKindModifier)
                        if argRefKind != RefKind.None && argRefKind != RefCapabilities.GetParameterRefKind(paramInfo) {
                            return false
                        }
                    }
                }
            } else if paramInfo.ParameterType.IsByRef && !paramInfo.IsIn {
                return false
            }
            let paramType = ResolveClrParameterType(symbolic, method, i, paramInfo, symbolicMethodTypeArgs)
            if (kind == ArgumentByReference || kind == ArgumentReadOnlyReference) && combination[i] is {} storageType {
                let pointee = if paramType is ByRefTypeSymbol byRef {
                    byRef.PointeeType
                } else {
                    paramType
                }
                if TypeSymbol.ContainsTypeParameter(pointee) ||
                    pointee
                    .ClrType
                    ?.ContainsGenericParameters == true ||
                    !ByRefStorageMatching.AreSameStorageType(storageType, pointee, out _, out _, out _) {
                    return false
                }
            }
            if !ArgumentPassesWithoutCode(paramType, types, kind) {
                return false
            }
        }
        return true
    }

    private func ResolveClrParameterType(
        symbolic TypeSymbol?,
        method MethodInfo,
        index int32,
        parameter ParameterInfo,
        symbolicMethodTypeArgs ImmutableArray[TypeSymbol?]
    ) TypeSymbol {
        let type = MemberLookup.GetClrMethodParameterConversionTargetTypeSymbol(
            symbolic,
            method,
            index,
            symbolicMethodTypeArgs
        ) ??
            (
            if symbolic != nil {
                MemberLookup.GetClrMethodParameterTypeSymbol(symbolic, method, index)
            } else {
                ClrNullability.GetParameterTypeSymbol(parameter)
            }
        )
        let pointee = if type is ByRefTypeSymbol byReference {
            byReference.PointeeType
        } else {
            type
        }
        return if parameter.ParameterType.IsByRef && !parameter.IsIn {
            ByRefTypeSymbol.Get(pointee)
        } else {
            pointee
        }
    }

    private func InstanceMethodAppliesToCallStep(
        receiver ReceiverType,
        step RegionReceiverStep,
        effects RegionEffects
    ) bool {
        if step.Name is not{} name {
            return false
        }
        if receiver.Symbol is StructSymbol declared {
            if !MemberLookup.CollectSourceInstanceMethods(declared, name).IsDefaultOrEmpty {
                return true
            }
            if HasDefaultInterfaceMethod(declared, name) || HasExtensionFunction(declared, name) {
                return false
            }
        } else if receiver.Symbol is InterfaceSymbol contract {
            if !TypeMemberModel.GetMethods(contract, name, MemberQuery.Instance(MemberKinds.Method)).IsDefaultOrEmpty {
                return true
            }
            return false
        }
        let needsOperatorResults = step.ArgumentForms.Any(
            (form RegionArgumentForm) -> form == RegionArgumentForm.StringByForm ||
                form == RegionArgumentForm.BuiltInByForm
        )
        let operatorResultsKnown = !needsOperatorResults ||
            (!inOperatorsRunUserCode && !OperatorsRunUserCode(effects, false))
        if !TryBuildCallArgumentInfo(
            step.Arguments,
            step.ArgumentForms,
            step.CallSyntax,
            effects,
            operatorResultsKnown,
            out _,
            out var argumentTypes,
            out var kinds
        ) ||
            !CanResolveOverloadArguments(argumentTypes, kinds) {
            return false
        }
        let symbolic = if receiver.Symbol is StructSymbol structReceiver {
            structReceiver.GetHierarchy().Last().ImportedBaseType
        } else {
            receiver.Symbol
        }
        let clrType = receiver.Clr ??
            symbolic?.ClrType ??
            (
            if receiver.Symbol is StructSymbol {
                typeof(object)
            } else {
                default(Type?)
            }
        )
        if clrType == nil || ReflectionType(clrType) is not{} reflected {
            return false
        }
        let allowProtectedInherited = receiver.Symbol is StructSymbol && Expressions?.GetFamilyAccessBase() != nil
        let methods = CollectClrCandidateMethods(reflected, name, staticAccess: false, allowProtectedInherited)
        if methods.Count == 0 {
            return false
        }
        guard let combinations = BuildArgumentTypeCombinations(argumentTypes, kinds) else {
            return false
        }
        for combination in combinations {
            if !TryBuildSyntheticBoundArguments(
                combination,
                kinds,
                step.Arguments,
                step.CallSyntax,
                effects,
                out var boundArgs
            ) ||
                !TryResolveClrCandidate(
                methods,
                symbolic,
                step.CallSyntax,
                boundArgs,
                combination,
                kinds,
                staticAccess: false,
                out _,
                out _,
                out _
            ) {
                return false
            }
        }
        return true
    }

    // Whether an argument reaches a parameter of a candidate without a conversion that runs code, whichever candidate
    // the binder selects. An argument passed by reference and a range convert nothing, a function literal converts
    // nothing into a delegate or function type, and a value does not bind a `ref` or `out` parameter. `nil` needs no
    // operator for a reference, nullable or type parameter type. A value needs none when no user-defined or imported
    // conversion operator reaches the parameter's type from its type (the binder's `HasUserDefinedImplicitConversion`).
    // A parameter that names a type parameter counts: the walker does not infer type arguments.
    private func ArgumentPassesWithoutCode(parameter TypeSymbol, types List[TypeSymbol]?, kind int32) bool {
        if kind == ArgumentByReference ||
            kind == ArgumentReadOnlyReference ||
            kind == ArgumentInlineDeclaration ||
            kind == ArgumentSkipped ||
            parameter is ByRefTypeSymbol {
            return true
        }
        // A function literal takes a delegate or function type without code; any other parameter type can take it
        // through a conversion operator from its function type (#5663).
        if kind == ArgumentFunction {
            let target = StripReferenceNullability(parameter) ?? parameter
            return target is FunctionTypeSymbol or
                DelegateTypeSymbol ||
                target.ClrType is {} clr &&
                ClrTypeUtilities.IsDelegateType(clr)
        }
        if kind == ArgumentNil {
            return AcceptsNilWithoutOperator(parameter)
        }
        let stripped = StripReferenceNullability(parameter) ?? parameter
        if TypeSymbol.ContainsTypeParameter(stripped) || stripped.ClrType?.ContainsGenericParameters == true {
            return false
        }
        if kind == ArgumentBuiltIn {
            return !BuiltInReachesThroughOperator(stripped) &&
                !BuiltInReachesThroughOperator(StripNullableValue(stripped))
        }
        guard let known = types else {
            return false
        }
        for type in known {
            if ConversionOperatorReaches(type, stripped) {
                return false
            }
        }
        return true
    }

    // Whether a conversion operator converts some built-in type other than `string` to the type. An operator
    // argument that is not a string form has such a type (`n + 1`); a string form has the path `string`.
    private func BuiltInReachesThroughOperator(type TypeSymbol) bool {
        builtInConversionTargets ??= Dictionary[TypeSymbol, bool]()
        if builtInConversionTargets!!.TryGetValue(type, out var known) {
            return known
        }
        let reaches = BuiltInReachesThroughOperatorCore(type)
        builtInConversionTargets!![type] = reaches
        return reaches
    }

    private var builtInConversionTargets Dictionary[TypeSymbol, bool]? = nil

    private func BuiltInReachesThroughOperatorCore(type TypeSymbol) bool {
        for builtin in BuiltInTypes() {
            if !object.Equals(builtin, TypeSymbol.String) && !object.Equals(builtin, TypeSymbol.Object) &&
                conversions.HasUserDefinedImplicitConversion(builtin, type) {
                return true
            }
        }
        return false
    }

    // A conversion operator converts the value to the target, directly or between their value types (a lifted
    // conversion). Every check without the `?` of a nullable value type is kept, so no operator is missed.
    private func ConversionOperatorReaches(source TypeSymbol, target TypeSymbol, allowExplicit bool = false) bool {
        let sourceValue = StripNullableValue(source)
        let targetValue = StripNullableValue(target)
        if TypeSymbol.ContainsTypeParameter(sourceValue) || TypeSymbol.ContainsTypeParameter(targetValue) ||
            sourceValue
            .ClrType
            ?.ContainsGenericParameters == true ||
            targetValue
            .ClrType
            ?.ContainsGenericParameters == true {
            return true
        }
        if sourceValue is TupleTypeSymbol sourceTuple &&
            targetValue is TupleTypeSymbol targetTuple &&
            sourceTuple
            .ElementTypes
            .Length == targetTuple
            .ElementTypes
            .Length {
            for var index = 0; index < sourceTuple.ElementTypes.Length; index++ {
                let sourceElement = StripReferenceNullability(sourceTuple.ElementTypes[index]) ??
                    sourceTuple.ElementTypes[index]
                let targetElement = StripReferenceNullability(targetTuple.ElementTypes[index]) ??
                    targetTuple.ElementTypes[index]
                if ConversionOperatorReaches(sourceElement, targetElement, allowExplicit) {
                    return true
                }
            }
        }
        return conversions.HasUserDefinedConversion(source, target, allowExplicit) ||
            conversions.HasUserDefinedConversion(sourceValue, target, allowExplicit) ||
            conversions.HasUserDefinedConversion(sourceValue, targetValue, allowExplicit) || Conversion.Classify(
            sourceValue,
            targetValue
        )
            .IsStructuralProjection
    }

    private func StripNullableValue(type TypeSymbol) TypeSymbol -> if type is NullableTypeSymbol nullable &&
        NullableLifting.IsAnyValueTypeNullable(nullable) {
        nullable.UnderlyingType
    } else {
        type
    }

    // `nil` reaches a reference type, a nullable type or a type parameter without an operator. A non-nullable value
    // type takes it only through a conversion operator (`func operator implicit(value string?) Token`).
    private func AcceptsNilWithoutOperator(type TypeSymbol) bool {
        if type is NullableTypeSymbol || type is TypeParameterSymbol || type is ByRefTypeSymbol || !type.IsValueType {
            return true
        }
        return type.ClrType is {} clr && NullableLifting.IsValueTypeNullableClr(clr)
    }

    // Whether `nil` reaches the target of a conversion without an operator. The receiver resolution strips
    // nullability, so a nullable declaration is read from the type clause, the variable or the return type.
    private func NilReachesTargetWithoutOperator(target RegionReceiverPath, effects RegionEffects) bool {
        if target.Steps.Length == 0 && !target.RootIsCall {
            if target.RootType is {} clause {
                if clause.IsNullable {
                    return true
                }
            } else if target.RootName == RegionEffectScanner.ReturnTypeRoot {
                if function is {} enclosing &&
                    !enclosing.IsReturnTypeInferred &&
                    !enclosing.DefersReturnConversion &&
                    enclosing.Type is {} returnType &&
                    AcceptsNilWithoutOperator(returnType) {
                    return true
                }
            } else if target.RootName is {} name && TryLookupRegionVariableType(name) is {} variableType {
                if AcceptsNilWithoutOperator(variableType) {
                    return true
                }
            }
        }
        if ConversionTypes(target, effects) is not{} types {
            return false
        }
        for type in types {
            if !AcceptsNilWithoutOperator(type) {
                return false
            }
        }
        return true
    }

    // The parameter lists of the candidates of a call's name that can take its number of arguments, on every type the
    // receiver can have; `nil` when the walker cannot list them all: a receiver that it does not resolve, an imported
    // base interface with a method of the name, a type without a method of the name that an extension method can
    // bind, or a candidate that can take another number of arguments (an optional or variadic parameter).
    private func CandidateParameterLists(call RegionCall, name string, effects RegionEffects, arity int32) List[
        List[TypeSymbol]
    ]? {
        let lists = List[List[TypeSymbol]]()
        let otherArity = HashSet[List[TypeSymbol]]()
        if call.Kind == RegionCallKind.NamedInvocation {
            for function in $scope.TryLookupFunctions(name) {
                if !AddFunctionParameterList(function, nil, lists, otherArity) {
                    return nil
                }
            }
        } else {
            var receivers List[ReceiverType]? = nil
            if call.ReceiverName is {} receiverName {
                let types = List[ReceiverType]()
                if AddRootTypes(receiverName, false, effects, types) {
                    receivers = types
                }
            } else if call.Receiver is {} path {
                receivers = ResolveReceiverPath(path, effects)
            }
            guard let resolved = receivers else {
                return nil
            }
            // A receiver that names a type selects its static methods; a value selects instance methods.
            let staticAccess = ReceiverNamesType(call)
            for receiver in resolved {
                let found = List[List[TypeSymbol]]()
                if name == RegionEffectScanner.IndexMemberName {
                    AddIndexParameterLists(receiver, call, effects, found)
                } else if !AddMethodParameterLists(receiver, name, staticAccess, found, otherArity) ||
                    !staticAccess &&
                    ExtensionMayBind(receiver, name, call.Arguments.Count) {
                    // An extension method can bind the call even when the type has methods of the name.
                    return nil
                }
                lists.AddRange(found)
            }
        }
        let candidates = List[List[TypeSymbol]]()
        for parameters in lists {
            if parameters.Count == arity {
                candidates.Add(parameters)
            } else if otherArity.Contains(parameters) {
                return nil
            }
        }
        return candidates
    }

    // Adds a source function's parameter list; one with a default value can also take fewer arguments. Returns
    // `false` for a variadic function: its expanded form converts each argument to the element type, at any arity.
    private func AddFunctionParameterList(
        function FunctionSymbol,
        level StructSymbol?,
        lists List[List[TypeSymbol]],
        otherArity HashSet[List[TypeSymbol]]
    ) bool {
        if function.Parameters.Any((parameter ParameterSymbol) -> parameter.IsVariadic) {
            return false
        }
        let types = List[TypeSymbol]()
        for parameter in function.Parameters {
            types.Add(PassedType(parameter, level?.SubstituteMemberType(parameter.Type) ?? parameter.Type))
        }
        lists.Add(types)
        if function.Parameters.Any((parameter ParameterSymbol) -> parameter.HasExplicitDefaultValue) {
            otherArity.Add(types)
        }
        return true
    }

    private func ReceiverNamesType(call RegionCall) bool {
        let root = call.ReceiverName ??
            (
            if call.Receiver is {} path && path.Steps.Length == 0 && !path.RootIsCall && path.RootType == nil {
                path.RootName
            } else {
                default(string?)
            }
        )
        if root == nil || TryLookupRegionVariableType(root) != nil {
            return false
        }
        return ResolveTypeName(root) != nil
    }

    // A `ref` or `out` parameter is listed as a by-reference type, so that the passing mode of an argument is
    // checked (`Use(out var v, dt)` does not take `Use(v int32, d DateTime)`).
    private func PassedType(parameter ParameterSymbol, type TypeSymbol) TypeSymbol ->
    if parameter.RefKind == RefKind.Ref || parameter.RefKind == RefKind.Out {
        ByRefTypeSymbol.Get(type)
    } else {
        type
    }

    // Adds the parameter lists of the methods of the name on the receiver's type. Returns `false` when the lists
    // are not complete: an imported interface does not list the methods of its base interfaces.
    private func AddMethodParameterLists(
        receiver ReceiverType,
        name string,
        staticAccess bool,
        lists List[List[TypeSymbol]],
        otherArity HashSet[List[TypeSymbol]]
    ) bool {
        var clrType = receiver.Clr
        var symbolic TypeSymbol? = nil
        switch receiver.Symbol {
            case declared is StructSymbol {
                for level in declared.GetHierarchy() {
                    for candidate in level.GetMembers() {
                        if candidate is FunctionSymbol function &&
                            function.Name == name &&
                            function.IsStatic == staticAccess &&
                            !AddFunctionParameterList(function, level, lists, otherArity) {
                            return false
                        }
                    }
                }
                let importedBase = declared.GetHierarchy().Last().ImportedBaseType
                clrType = importedBase?.ClrType
                symbolic = importedBase
            }
            case contract is InterfaceSymbol {
                for level in contract.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    // A receiver that names the interface selects its `shared` (static) methods.
                    let functions = if staticAccess {
                        level.GetStaticMethods(name)
                    } else {
                        level.GetMethods(name)
                    }
                    for function in functions {
                        if function.Parameters.Any((parameter ParameterSymbol) -> parameter.IsVariadic) {
                            return false
                        }
                        let types = List[TypeSymbol]()
                        for parameter in function.Parameters {
                            types.Add(PassedType(parameter, level.SubstituteMemberType(parameter.Type)))
                        }
                        lists.Add(types)
                        if function.Parameters.Any((parameter ParameterSymbol) -> parameter.HasExplicitDefaultValue) {
                            otherArity.Add(types)
                        }
                    }
                    // The methods of an imported base interface are not listed, as for an imported interface.
                    for clrBase in level.BaseClrInterfaces {
                        if (MemberShape(clrBase, name) & MemberIsMethod) != 0 {
                            return false
                        }
                    }
                }
            }
            case imported is ImportedTypeSymbol {
                clrType = imported.OpenDefinition ?? imported.ClrType
                symbolic = imported
            }
            default {
                clrType = clrType ?? receiver.Symbol?.ClrType
                symbolic = receiver.Symbol
            }
        }
        if clrType == nil || ReflectionType(clrType) is not{} reflected {
            return true
        }
        try {
            if reflected.IsInterface {
                for contract in reflected.GetInterfaces() {
                    if (ClrMemberShape(contract, name) & MemberIsMethod) != 0 {
                        return false
                    }
                }
            }
            let allowProtectedInherited = !staticAccess &&
                receiver.Symbol is StructSymbol &&
                Expressions?.GetFamilyAccessBase() != nil
            for method in CollectClrCandidateMethods(reflected, name, staticAccess, allowProtectedInherited) {
                let methodParameters = method.GetParameters()
                let types = ClrParameterTypes(symbolic, method, methodParameters)
                lists.Add(types)
                // The CLR resolver also takes a candidate in expanded form, which converts each argument to the
                // element type at any arity, or with omitted optional parameters.
                if methodParameters.Length > 0 &&
                    methodParameters[methodParameters.Length - 1]
                    .GetCustomAttributesData().Any(
                    (data CustomAttributeData) -> data
                        .AttributeType
                        .FullName == "System.ParamArrayAttribute" ||
                        data
                        .AttributeType
                        .FullName == "System.Runtime.CompilerServices.ParamCollectionAttribute"
                ) {
                    return false
                }
                if methodParameters.Any((parameter ParameterInfo) -> parameter.IsOptional) {
                    otherArity.Add(types)
                }
            }
        } catch (ex NotSupportedException) {
            return false
        }
        return true
    }

    private func ClrParameterTypes(symbolic TypeSymbol?, method MethodBase, parameters[]ParameterInfo) List[
        TypeSymbol
    ] {
        let types = List[TypeSymbol]()
        for var index = 0; index < parameters.Length; index++ {
            let type = if symbolic != nil {
                MemberLookup.GetClrMethodParameterTypeSymbol(symbolic, method, index)
            } else {
                ClrNullability.GetParameterTypeSymbol(parameters[index])
            }
            let pointee = if type is ByRefTypeSymbol byReference {
                byReference.PointeeType
            } else {
                type
            }
            // A `ref` or `out` parameter is by reference; an `in` parameter takes a value.
            types.Add(
                if parameters[index].ParameterType.IsByRef && !parameters[index].IsIn {
                    ByRefTypeSymbol.Get(pointee)
                } else {
                    pointee
                }
            )
        }
        return types
    }

    // The parameter lists of an index access: `int32` per dimension (or one `System.Index`) for an array, a slice or
    // a string, and the indexers of an imported type with the receiver's type arguments substituted. A range argument
    // is not matched: the binder slices the target, and the read classification decides whether that runs user code
    // (R16, R17), as on main. A source indexer is a getter that runs user code (R14), which the read classification
    // counts, so it is not listed.
    // Whether the one argument of an index access is a `System.Index`, which the binder takes as it is; any other
    // value is converted to `int32`.
    private func ArgumentIsSystemIndex(call RegionCall, effects RegionEffects) bool {
        if call.Arguments[0] is not{} path || ConversionTypes(path, effects) is not{} types || types.Count == 0 {
            return false
        }
        for type in types {
            if type.ClrType is not{} clr || !ClrTypeUtilities.AreSame(clr, typeof(Index)) {
                return false
            }
        }
        return true
    }

    private func AddIndexParameterLists(
        receiver ReceiverType,
        call RegionCall,
        effects RegionEffects,
        lists List[List[TypeSymbol]]
    ) {
        let count = call.Arguments.Count
        var rank = 0
        switch receiver.Symbol {
            case ArrayTypeSymbol, SliceTypeSymbol {
                rank = 1
            }
            case rectangular is RectangularArrayTypeSymbol {
                rank = rectangular.Rank
            }
            default {
                if object.Equals(receiver.Symbol, TypeSymbol.String) {
                    rank = 1
                } else if receiver.Clr is {} clr && clr.IsArray {
                    rank = clr.GetArrayRank()
                } else if receiver.Clr is {} text && ClrTypeUtilities.AreSame(text, typeof(string)) {
                    rank = 1
                }
            }
        }
        if rank > 0 {
            if rank == count {
                let dimensions = List[TypeSymbol]()
                for var index = 0; index < rank; index++ {
                    dimensions.Add(TypeSymbol.Int32)
                }
                lists.Add(dimensions)
            }
            if count == 1 && ArgumentIsSystemIndex(call, effects) {
                let fromEnd = List[TypeSymbol]()
                fromEnd.Add(TypeSymbol.FromClrTypeWithoutNullability(typeof(Index), NullabilityFreeReason.TypeLiteral))
                lists.Add(fromEnd)
            }
            return
        }
        var clrType = receiver.Clr
        var symbolic TypeSymbol? = nil
        switch receiver.Symbol {
            case StructSymbol {
                return
            }
            case imported is ImportedTypeSymbol {
                clrType = imported.OpenDefinition ?? imported.ClrType
                symbolic = imported
            }
            default {
                clrType = clrType ?? receiver.Symbol?.ClrType
                symbolic = receiver.Symbol
            }
        }
        if clrType == nil || ReflectionType(clrType) is not{} reflected {
            return
        }
        try {
            let searched = List[Type]()
            searched.Add(reflected)
            if reflected.IsInterface {
                searched.AddRange(reflected.GetInterfaces())
            }
            for searchedType in searched {
                for property in searchedType.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                    let indexParameters = property.GetIndexParameters()
                    if indexParameters.Length != count {
                        continue
                    }
                    let types = List[TypeSymbol]()
                    for var index = 0; index < count; index++ {
                        types.Add(
                            if symbolic != nil {
                                MemberLookup.GetIndexerParameterTypeSymbol(symbolic, property, index)
                            } else {
                                ClrNullability.GetParameterTypeSymbol(indexParameters[index])
                            }
                        )
                    }
                    lists.Add(types)
                }
            }
        } catch (ex NotSupportedException) { }
    }

    // ADR-0208 R19 (#5593) inside a loop: a constant pattern calls the `Equals` of its input when the shared R19
    // decision says so for a type that the walker resolves for the subject and the value. A name that is a type
    // tests the type (`o is Kind`); a subject that does not resolve can call it.
    private func PatternTestRunsUserCode(test RegionPatternTest, effects RegionEffects) bool {
        // A switch case resolves a value before a type, so a name that is a variable of the entry scope is a value.
        if test.Candidate is {} candidate &&
            !(candidate.TypeName is {} typeName && TryLookupRegionVariableType(FirstNameSegment(typeName)) != nil) &&
            TestedType(candidate, out _) != nil {
            return false
        }
        if test.ValueIsNull || RegionPatternValueIsNull(test, effects) {
            return false
        }
        if test.Subject is not{} subject || ConversionTypes(subject, effects) is not{} inputs || inputs.Count == 0 {
            return true
        }
        let values = if test.Value is {} value {
            ConversionTypes(value, effects)
        } else {
            default(List[TypeSymbol]?)
        }
        for input in inputs {
            if values == nil || values.Count == 0 {
                if PatternTestOfTypesRunsUserCode(input, test.ValueIsNull, nil) {
                    return true
                }
                continue
            }
            for valueType in values {
                if PatternTestOfTypesRunsUserCode(input, test.ValueIsNull, valueType) {
                    return true
                }
            }
        }
        return false
    }

    private func RegionPatternValueIsNull(test RegionPatternTest, effects RegionEffects) bool {
        guard let constant = test.ConstantValue else {
            return false
        }
        if constant.Path is {} path && !RegionConstantPathIsNull(path) {
            return false
        }
        if constant.Targets.IsDefaultOrEmpty {
            return true
        }
        let sourceTypes = if constant.Path is {} path {
            ConversionTypes(path, effects)
        } else {
            List[TypeSymbol]{TypeSymbol.Null}
        }
        guard let initialSources = sourceTypes else {
            return false
        }
        var sources = initialSources
        if sources.Count == 0 {
            return false
        }
        for target in constant.Targets {
            guard let types = ConversionTypes(target, effects) else {
                return false
            }
            if types.Count == 0 {
                return false
            }
            for source in sources {
                for type in types {
                    if !Conversion.PreservesNull(source, type) {
                        return false
                    }
                }
            }
            sources = types
        }
        return true
    }

    private func RegionConstantPathIsNull(path RegionReceiverPath) bool {
        if path.RootIsCall || path.RootType != nil || path.RootLiteralType != nil {
            return false
        }
        guard let names = PatternNameSegments(path, nil) else {
            return false
        }
        if names.Count == 1 {
            return ConstantExpressionEvaluator.IsNullConstantSymbol($scope.TryLookupSymbol(names[0]))
        }
        guard let owner = ResolveTestedType(string.Join(".", names.Take(names.Count - 1)), 0) else {
            return false
        }
        let name = names[names.Count - 1]
        if owner is StructSymbol structure && TypeMemberModel.TryGetStaticFieldIncludingInherited(
            structure,
            name,
            out var field,
            out _
        ) {
            return ConstantExpressionEvaluator.IsNullConstantSymbol(field)
        }
        if owner is InterfaceSymbol contract {
            return ConstantExpressionEvaluator.IsNullConstantSymbol(contract.GetStaticField(name))
        }
        if owner.ClrType is {} clr && ReflectionType(clr) is {} reflected && reflected.GetField(
            name,
            BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy
        ) is {} clrField {
            return ConstantExpressionEvaluator.TryGetClrFieldConstantValue(clrField, out var value) && value == nil
        }
        return false
    }

    private func FirstNameSegment(name string) string {
        let dot = name.IndexOf('.')
        return if dot < 0 {
            name
        } else {
            name.Substring(0, dot)
        }
    }

    private func PatternTestOfTypesRunsUserCode(input TypeSymbol, valueIsNull bool, valueType TypeSymbol?) bool ->
    ConstantPatternTestRunsUserCode(
        BoundConstantPattern.ClassifyTestOf(input, valueIsNull, valueType),
        input,
        valueIsNull
    )

    private func StorageOperandNamesRoot(argSyntax ExpressionSyntax?, root string) bool {
        if argSyntax == nil {
            return true
        }
        var operand ExpressionSyntax? = argSyntax
        while operand is ParenthesizedExpressionSyntax parenthesized {
            operand = parenthesized.Expression
        }
        if operand is RefArgumentExpressionSyntax refArg {
            operand = refArg.Expression
        } else if operand is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.AmpersandToken}} address {
            operand = address.Operand
        }
        while operand is ParenthesizedExpressionSyntax parenthesized {
            operand = parenthesized.Expression
        }
        return operand is NameExpressionSyntax name && name.IdentifierToken.ValueText == root
    }

    private func IsOutStorageArgument(argSyntax ExpressionSyntax?) bool {
        var current = argSyntax
        while current is ParenthesizedExpressionSyntax parenthesized {
            current = parenthesized.Expression
        }
        return current is RefArgumentExpressionSyntax refArg &&
            (refArg.IsInlineDeclaration || refArg.RefKindModifier.Text == "out")
    }

    private func StorageTypes(path RegionReceiverPath?, argSyntax ExpressionSyntax?, effects RegionEffects) List[
        TypeSymbol
    ]? {
        if path is not{} origin || origin.Steps.Length > 0 || origin.RootType?.HasTypeArguments == true {
            return nil
        }
        if !origin.RootIsCall &&
            origin.RootName is {} root &&
            (
            HasEnclosingDeclaration(argSyntax, root, constOnly: false) ||
                !StorageOperandNamesRoot(argSyntax, root) ||
                $scope.TryLookupSymbol(root) is not LocalVariableSymbol and not GlobalVariableSymbol
        ) {
            return nil
        }
        if ResolveReceiverPath(
            origin,
            effects,
            keepNullableValueAtEnd: true,
            keepReferenceNullabilityAtEnd: true,
            forStorageAtEnd: true,
            forOutStorageAtEnd: IsOutStorageArgument(argSyntax)
        ) is not{} types {
            return nil
        }
        let result = List[TypeSymbol]()
        for type in types {
            if type.Symbol is {} symbol {
                if TypeSymbol.ContainsTypeParameter(symbol) || symbol.ClrType?.ContainsGenericParameters == true {
                    return nil
                }
                result.Add(symbol)
            } else if type.Clr is {} clr {
                if origin.Steps.Length > 0 && !clr.IsValueType {
                    return nil
                }
                result.Add(
                    BuiltInType(clr.FullName) ?? TypeSymbol.FromClrTypeWithoutNullability(
                        clr,
                        NullabilityFreeReason.ResolvedTypeName
                    )
                )
            }
        }
        return if result.Count == 0 {
            default(List[TypeSymbol]?)
        } else {
            result
        }
    }

    private func HasTrailingNullAssertion(argSyntax ExpressionSyntax?) bool {
        var current = argSyntax
        while current is ParenthesizedExpressionSyntax parenthesized {
            current = parenthesized.Expression
        }
        return current is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.BangBangToken}}
    }

    private func OverloadValueTypes(path RegionReceiverPath, asserted bool, effects RegionEffects) List[TypeSymbol]? {
        if ResolveReceiverPath(
            path,
            effects,
            keepNullableValueAtEnd: true,
            keepReferenceNullabilityAtEnd: true
        ) is not{} types {
            return nil
        }
        let result = List[TypeSymbol]()
        for type in types {
            if type.Symbol is {} symbol {
                result.Add(
                    if asserted {
                        StripAllNullability(symbol) ?? symbol
                    } else {
                        symbol
                    }
                )
            } else if type.Clr is {} clr {
                let resolved = BuiltInType(clr.FullName) ?? TypeSymbol.FromClrTypeWithoutNullability(
                    clr,
                    NullabilityFreeReason.ResolvedTypeName
                )
                result.Add(
                    if asserted {
                        StripAllNullability(resolved) ?? resolved
                    } else {
                        resolved
                    }
                )
                if !asserted && path.Steps.Length > 0 && !clr.IsValueType {
                    result.Add(NullableTypeSymbol.Get(resolved))
                }
            }
        }
        return if result.Count == 0 {
            default(List[TypeSymbol]?)
        } else {
            result
        }
    }

    // The types of a value at a conversion site. A nullable value type keeps its `?` (`DateTime?` and `DateTime`
    // take different conversions); reference nullability does not change one.
    private func ConversionTypes(path RegionReceiverPath, effects RegionEffects) List[TypeSymbol]? {
        if ResolveReceiverPath(path, effects, keepNullableValueAtEnd: true) is not{} types {
            return nil
        }
        let result = List[TypeSymbol]()
        for type in types {
            if type.Symbol is {} symbol {
                result.Add(symbol)
            } else if type.Clr is {} clr {
                result.Add(
                    BuiltInType(clr.FullName) ?? TypeSymbol.FromClrTypeWithoutNullability(
                        clr,
                        NullabilityFreeReason.ResolvedTypeName
                    )
                )
            }
        }
        return result
    }

    private func NamesReferenceStorage(path AccessPath) bool {
        let root = path.Root
        return (
            root is ParameterSymbol parameter && (parameter.RefKind == RefKind.Ref || parameter.RefKind == RefKind.Out)
        ) ||
            IsByReferenceRoot(root) ||
            IsExternalStorageAlias(root)
    }

    private func ReadsRunUserCode(effects RegionEffects, forReferenceStorage bool) bool {
        for read in effects.MemberReads {
            if ReadRunsUserCode(read, effects) {
                return true
            }
        }
        for read in effects.PatternReads {
            if PatternReadRunsUserCode(read, effects) {
                return true
            }
        }
        for compared in effects.NilCompareOperandPaths {
            if NilCompareRunsUserOperator(compared, effects, forReferenceStorage) {
                return true
            }
        }
        if (effects.IndexAccesses.Count > 0 || effects.PatternIndexAccesses.Count > 0) &&
            IndexArgumentsRunUserConversion(effects, !OperatorsRunUserCode(effects, false)) {
            return true
        }
        return false
    }

    // A read of a constant pattern names a type (`o is System.String`, `o is Box[int32]`), a namespace on the way to
    // one (`System.Text`), or a member. A member of a variable or a call is a read. Otherwise the longest prefix of
    // the dotted name that names a type decides: the whole name is a type (no code), or one member of the type
    // follows it and is classified as a read (a static property runs its getter, a constant or an enum member
    // does not). A name with no type prefix is a namespace on the way to a type that is read separately.
    private func PatternReadRunsUserCode(read RegionMemberRead, effects RegionEffects) bool {
        guard let path = read.Receiver else {
            return true
        }
        if path.RootIsCall ||
            path.RootType != nil ||
            path.RootLiteralType != nil ||
            path.RootName is {} root &&
            TryLookupRegionVariableType(root) != nil {
            return ReadRunsUserCode(read, effects)
        }
        guard let segments = PatternNameSegments(path, read.Member) else {
            return ReadRunsUserCode(read, effects)
        }
        if read.Member == nil {
            // An index of a name: a generic type with type arguments (`List[int32]`).
            let name = string.Join(".", segments)
            for var arity = 0; arity <= 4; arity++ {
                if ResolveTestedType(name, arity) != nil {
                    return false
                }
            }
            return true
        }
        for var length = segments.Count; length >= 1; length-- {
            guard let type = ResolveTestedType(string.Join(".", segments.Take(length)), 0) else {
                continue
            }
            if length == segments.Count {
                return false
            }
            if length == segments.Count - 1 {
                return ReadOfTypeRunsUserCode(ReceiverType(type, nil), segments[length])
            }
            return true
        }
        return false
    }

    // The segments of a pattern read made of member steps only (`System`, `Text`, `StringBuilder`), or `nil`.
    private func PatternNameSegments(path RegionReceiverPath, member string?) List[string]? {
        guard let root = path.RootName else {
            return nil
        }
        let segments = List[string]()
        segments.Add(root)
        for step in path.Steps {
            if step.Kind != RegionReceiverStepKind.Member || step.Name is not{} name {
                return nil
            }
            segments.Add(name)
        }
        if member != nil {
            segments.Add(member)
        }
        return segments
    }

    private func NilCompareNameRunsUserOperator(name string, effects RegionEffects) bool {
        guard let comparedType = TryLookupRegionVariableType(name) else {
            return false
        }
        // A non-nullable value type compared with `nil` may select a user-defined `==`, as may a reference-typed
        // variable or implicit member narrowed to a value type at the entry scope or inside the region.
        if object.Equals(StripAllNullability(comparedType), TypeSymbol.Object) ||
            (comparedType !is NullableTypeSymbol && !IsReferenceLikeType(comparedType)) {
            return true
        }
        let symbol = $scope.TryLookupSymbol(name)
        if symbol is VariableSymbol variable {
            if (
                variable is ImplicitFieldVariableSymbol or
                    ImplicitPropertyVariableSymbol or
                    ImplicitStaticFieldVariableSymbol or
                    ImplicitStaticPropertyVariableSymbol
            ) &&
                (effects.ContainsMemberTypeTest || HasEntryMemberTypeTest()) {
                return true
            }
        } else if effects.ContainsMemberTypeTest || HasEntryMemberTypeTest() {
            return true
        }
        if !NullableLifting.IsAnyValueTypeNullable(comparedType as NullableTypeSymbol) &&
            NilCompareRunsUserOperator(
            RegionReceiverPath(name, false, nil, nil, ImmutableArray[RegionReceiverStep].Empty),
            effects,
            false
        ) {
            return true
        }
        return false
    }

    // Whether a member or an element compared with `nil` has an imported value type whose `==` or `!=` takes a
    // reference (`operator ==(Token, object)`), which the comparison calls. A source operator is a plain call
    // (A3). An operand that does not resolve can run one.
    private func NilCompareRunsUserOperator(
        compared RegionReceiverPath?,
        effects RegionEffects,
        forReferenceStorage bool
    ) bool {
        if compared == nil ||
            (
            compared
                .Steps
                .Length > 0 &&
                (effects.ContainsMemberTypeTest || HasEntryMemberTypeTest() || HasTypeTestOnReceiver(compared, effects))
        ) ||
            ResolveReceiverPath(compared, effects, keepNullableValueAtEnd: true) is not{} types {
            return true
        }
        for type in types {
            if !forReferenceStorage {
                if type.Symbol is {} symbol {
                    if object.Equals(symbol, TypeSymbol.Object) ||
                        (symbol !is NullableTypeSymbol && !IsReferenceLikeType(symbol)) {
                        return true
                    }
                } else if type.Clr is {} clrType && ReflectionType(clrType) is {} reflectedClr {
                    if reflectedClr.FullName == "System.Object" ||
                        (reflectedClr.IsValueType && !NullableLifting.IsValueTypeNullableClr(reflectedClr)) {
                        return true
                    }
                }
            }
            var clr = type.Clr ??
                (
                if type.Symbol is StructSymbol {
                    default(Type?)
                } else {
                    StripAllNullability(type.Symbol)?.ClrType
                }
            )
            clr = NullableLifting.GetValueTypeNullableUnderlyingClr(clr) ?? clr
            if clr != nil && ClrEqualityTakesReference(clr) {
                return true
            }
        }
        return false
    }

    private func ClrEqualityTakesReference(type Type) bool {
        if ReflectionType(type) is not{} reflected || !reflected.IsValueType {
            return false
        }
        try {
            for method in reflected.GetMethods(BindingFlags.Public | BindingFlags.Static) {
                if method.Name != "op_Equality" && method.Name != "op_Inequality" {
                    continue
                }
                for parameter in method.GetParameters() {
                    let parameterType = parameter.ParameterType
                    if !parameterType.IsValueType || NullableLifting.IsValueTypeNullableClr(parameterType) {
                        return true
                    }
                }
            }
        } catch (ex NotSupportedException) {
            return true
        }
        return false
    }

    // Whether a member or index read can run user code, with the rules of the straight-line pass and the
    // non-hiding requirement of #5549: a field of a value type or of a class that cannot have a subclass, a tuple
    // element, an array or slice element or length and an enum member run none; a source property runs user code
    // unless it is an auto property on a receiver type that cannot have a subclass (R14, #5549); an imported
    // property or indexer runs user code unless `IsStableClrAccessor` lists it (R16, R17). A receiver that does
    // not resolve or is type-tested in the region can run user code.
    private func ReadRunsUserCode(read RegionMemberRead, effects RegionEffects) bool {
        let path = read.Receiver
        if path == nil ||
            (path.Steps.Length > 0 && (effects.ContainsMemberTypeTest || HasEntryMemberTypeTest())) ||
            HasTypeTestOnReceiver(path, effects) {
            return true
        }
        let types = ResolveReceiverPath(path, effects, keepNullableValueAtEnd: true)
        if types == nil {
            return true
        }
        for type in types {
            if ReadOfTypeRunsUserCode(type, read.Member) {
                return true
            }
        }
        return false
    }

    private func HasTypeTestOnReceiver(path RegionReceiverPath, effects RegionEffects) bool {
        if path.RootName is not{} root || path.RootIsCall {
            return false
        }
        for test in effects.TypeTests {
            if test.Name == root {
                let tested = TestedType(test, out var testsConstant)
                if tested != nil || !testsConstant {
                    return true
                }
            }
        }
        return false
    }

    private func HasEntryMemberTypeTest() bool {
        for var i = 0; i < binderCtx.NarrowedVariables.Count; i++ {
            for entry in binderCtx.NarrowedVariables[i] {
                if !entry.Key.HasMembers {
                    continue
                }
                let declared = StripAllNullability(NarrowingState.DeclaredNonNullType(entry.Key))
                if declared == nil || !object.Equals(declared, StripAllNullability(entry.Value)) {
                    return true
                }
            }
        }
        return false
    }

    private func ReadOfTypeRunsUserCode(type ReceiverType, member string?) bool {
        if type.Clr is {} clr {
            if NullableLifting.GetValueTypeNullableUnderlyingClr(clr) is {} underlyingClr {
                if member == "Value" {
                    return true
                }
                if member == "HasValue" {
                    return ClrDeclaresMember(underlyingClr, "HasValue") &&
                        ClrReadRunsUserCode(underlyingClr, "HasValue", false)
                }
                return ClrReadRunsUserCode(underlyingClr, member, false)
            }
            return ClrReadRunsUserCode(clr, member, false)
        }
        let symbol = type.Symbol
        switch symbol {
            case nil {
                return true
            }
            case nullable is NullableTypeSymbol {
                if StripAllNullability(nullable.UnderlyingType) is not{} underlying {
                    return true
                }
                if member == "Value" {
                    return true
                }
                if member == "HasValue" {
                    return TypeDeclaresMember(underlying, "HasValue") &&
                        ReadOfTypeRunsUserCode(ReceiverType(underlying, nil), "HasValue")
                }
                return ReadOfTypeRunsUserCode(ReceiverType(underlying, nil), member)
            }
            case ArrayTypeSymbol, SliceTypeSymbol, RectangularArrayTypeSymbol {
                // An element and the length of an array or a slice are intrinsic reads.
                return false
            }
            case tuple is TupleTypeSymbol {
                if member != nil {
                    return false
                }
            }
            case EnumSymbol {
                return member == nil
            }
            case declared is StructSymbol {
                let canHaveSubclass = declared.IsClass && (declared.IsOpen || declared.IsSealedHierarchy)
                let hierarchy = declared.GetHierarchy()
                for level in hierarchy {
                    for candidate in level.GetMembers() {
                        if member == nil {
                            if candidate is PropertySymbol{IsIndexer: true} {
                                return true
                            }
                        } else if candidate.Name == member {
                            switch candidate {
                                case field is FieldSymbol {
                                    // A constant is inlined and initializes nothing; an instance field on a class
                                    // that can have a subclass can be hidden by a derived getter (#5549).
                                    if !field.IsStatic {
                                        return canHaveSubclass
                                    }
                                    return !field.IsConst && TypeInitializationRunsUserCode(level, true)
                                }
                                case property is PropertySymbol {
                                    // ADR-0208 R14 (#5599) and #5549: an instance property on a class that can have
                                    // a subclass can be overridden or hidden by a derived getter.
                                    if !property.IsStatic && canHaveSubclass {
                                        return true
                                    }
                                    return SourcePropertyRunsUserCode(
                                        property,
                                        if property.IsStatic {
                                            default(TypeSymbol?)
                                        } else {
                                            declared
                                        }
                                    ) ||
                                        property.IsStatic &&
                                        TypeInitializationRunsUserCode(level, true)
                                }
                                default {
                                    return true
                                }
                            }
                        }
                    }
                }
                if hierarchy.Last().ImportedBaseType is {} importedBase {
                    return ReadOfTypeRunsUserCode(ReceiverType(importedBase, nil), member)
                }
                if !declared.IsClass {
                    return ClrReadRunsUserCode(typeof(Nullable[_]), member, true)
                }
                return true
            }
            case imported is ImportedTypeSymbol {
                // An index read over a type-parameter argument is emitted through `IList` or `IDictionary` (R17).
                if member == nil && imported.HasTypeParameterArgument {
                    return true
                }
                if imported.OpenDefinition is {} definition {
                    return ClrReadRunsUserCode(definition, member, true)
                }
            }
            default { }
        }
        if symbol?.ClrType is not{} clrType {
            return true
        }
        return ClrReadRunsUserCode(clrType, member, false)
    }

    private func TypeDeclaresMember(type TypeSymbol, member string) bool {
        if type is StructSymbol declared {
            for level in declared.GetHierarchy() {
                for candidate in level.GetMembers() {
                    if candidate.Name == member {
                        return true
                    }
                }
            }
            return false
        }
        if type.ClrType is {} clr {
            return ClrDeclaresMember(clr, member)
        }
        return false
    }

    private func ClrDeclaresMember(type Type, member string) bool {
        if ReflectionType(type) is not{} reflected {
            return true
        }
        try {
            let flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
            return reflected.GetMember(member, flags).Length > 0
        } catch (ex NotSupportedException) {
            return true
        }
    }

    // An imported read: a field of a value type or sealed class or a constant runs no user code; a property or an
    // indexer runs user code unless `IsStableClrAccessor` lists its getter. A member that is not found can run user code.
    private func ClrReadRunsUserCode(type Type, member string?, isDefinition bool) bool {
        if ReflectionType(type) is not{} reflected {
            return true
        }
        try {
            if member == nil && reflected.IsArray {
                return false
            }
            // Only a public member can be read by name or by indexing; an explicit interface implementation cannot.
            let flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
            let searched = List[Type]()
            searched.Add(reflected)
            if reflected.IsInterface {
                searched.AddRange(reflected.GetInterfaces())
            }
            var found = false
            for searchedType in searched {
                if member == nil {
                    for property in searchedType.GetProperties(flags) {
                        if property.GetIndexParameters().Length > 0 {
                            found = true
                            if !IsStableClrAccessor(property, isSetter: false) {
                                return true
                            }
                        }
                    }
                } else {
                    for clrMember in searchedType.GetMember(member, flags) {
                        if clrMember is FieldInfo field {
                            if !field.IsStatic && !reflected.IsSealed {
                                return true
                            }
                            if field.IsStatic && !ConstantExpressionEvaluator.TryGetClrFieldConstantValue(
                                field,
                                out _
                            ) &&
                                ClrStaticMemberOwnerInitializes(field.DeclaringType ?? reflected) {
                                return true
                            }
                            found = true
                        } else if clrMember is PropertyInfo property && property.GetIndexParameters().Length == 0 {
                            found = true
                            if !IsStableClrAccessor(property, isSetter: false) {
                                return true
                            }
                        } else {
                            return true
                        }
                    }
                }
            }
            if !found && reflected.IsValueType && member != nil && !ClrTypeUtilities.AreSame(
                reflected,
                typeof(Nullable[_])
            ) {
                return ClrReadRunsUserCode(typeof(Nullable[_]), member, true)
            }
            return !found
        } catch (ex NotSupportedException) {
            return true
        }
    }

    // Whether an extension method of the name, of the package or imported, can bind a call on the receiver.
    private func ExtensionMayBind(receiver ReceiverType, name string, argumentCount int32? = nil) bool {
        let receiverType = receiver.Symbol ??
            (
            if receiver.Clr is {} clr {
                BuiltInType(clr.FullName) ?? TypeSymbol.FromClrTypeWithoutNullability(
                    clr,
                    NullabilityFreeReason.ResolvedTypeName
                )
            } else {
                default(TypeSymbol?)
            }
        )
        if HasExtensionFunction(receiverType, name) {
            return true
        }
        let imported = MemberLookup(binderCtx).CollectImportedExtensionMethods(name)
        if imported.Count == 0 {
            return false
        }
        if receiverType == nil {
            return true
        }
        for candidate in imported {
            try {
                if ClrOverloadResolution.MayAcceptExtensionReceiver(candidate, receiverType, argumentCount, nil) {
                    return true
                }
            } catch (ex Exception) when ex !is OutOfMemoryException {
                return true
            }
        }
        return false
    }

    private func HasExtensionFunction(receiverType TypeSymbol?, member string) bool {
        if receiverType == nil {
            return false
        }
        return !$scope.TryLookupExtensionFunctions(receiverType, member).IsDefaultOrEmpty
    }

    private const MemberIsMethod int32 = 1
    private const MemberIsValue int32 = 2

    // The kinds of the members of the name on the type, its base types, its base interfaces and its constraints:
    // `MemberIsMethod` for a method, `MemberIsValue` for a field, a property or an event. The members of a
    // function or delegate type that invoke it (`Invoke`, `BeginInvoke`, `DynamicInvoke`) are values.
    private func MemberShape(type TypeSymbol?, member string) int32 {
        switch type {
            case nil {
                return 0
            }
            case FunctionTypeSymbol, DelegateTypeSymbol {
                if InvokesDelegate(member) {
                    return MemberIsValue
                }
                return ClrTypeShape(type?.ClrType ?? typeof(MulticastDelegate), member)
            }
            case declared is StructSymbol {
                var shape = 0
                let hierarchy = declared.GetHierarchy()
                for level in hierarchy {
                    for symbol in level.GetMembers() {
                        if symbol.Name == member {
                            shape = shape | ShapeOf(symbol is FunctionSymbol)
                        }
                    }
                }
                let importedBase = hierarchy.Last().ImportedBaseType
                if importedBase != nil {
                    return shape | MemberShape(importedBase, member)
                }
                return shape | ClrMemberShape(typeof(object), member)
            }
            case contract is InterfaceSymbol {
                var shape = ClrMemberShape(typeof(object), member)
                for level in contract.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    if !level.GetMethods(member).IsDefaultOrEmpty || !level.GetStaticMethods(member).IsDefaultOrEmpty {
                        shape = shape | MemberIsMethod
                    }
                    for symbol in level.Properties {
                        if symbol.Name == member {
                            shape = shape | MemberIsValue
                        }
                    }
                    for symbol in level.Events {
                        if symbol.Name == member {
                            shape = shape | MemberIsValue
                        }
                    }
                    for symbol in level.StaticFields {
                        if symbol.Name == member {
                            shape = shape | MemberIsValue
                        }
                    }
                    for symbol in level.ConstFields {
                        if symbol.Name == member {
                            shape = shape | MemberIsValue
                        }
                    }
                    for clrBase in level.BaseClrInterfaces {
                        shape = shape | MemberShape(clrBase, member)
                    }
                }
                return shape
            }
            case parameter is TypeParameterSymbol {
                var shape = ClrMemberShape(typeof(object), member)
                let visited = HashSet[TypeParameterSymbol]()
                var current TypeParameterSymbol? = parameter
                while current != nil && visited.Add(current) {
                    shape = shape | MemberShape(current.InterfaceConstraint, member)
                    shape = shape | MemberShape(current.ClrInterfaceConstraint, member)
                    shape = shape | MemberShape(current.ClassConstraint, member)
                    current = current.TypeParameterBound
                }
                return shape
            }
            case EnumSymbol {
                return ClrMemberShape(typeof(Enum), member)
            }
            default {
                if type is TupleTypeSymbol tuple && tuple.TryGetElementIndexByName(member, out var element) {
                    return MemberIsValue
                }
                if type?.ClrType is not{} clrType {
                    return 0
                }
                return ClrTypeShape(clrType, member)
            }
        }
    }

    // A generic instantiation over a type that emit still defines answers member queries by throwing; its
    // definition has the same members. A type that emit still defines is not reflected.
    private func ReflectionType(type Type) Type? {
        if ClrTypeUtilities.IsTypeBuilderInstantiation(type) {
            return type.GetGenericTypeDefinition()
        }
        if ClrTypeUtilities.IsUnfinishedEmitType(type) {
            return nil
        }
        return type
    }

    private func ClrTypeShape(type Type, member string) int32 {
        if ReflectionType(type) is not{} reflected {
            return MemberIsValue
        }
        try {
            return ClrTypeShapeCore(reflected, member)
        } catch (ex NotSupportedException) {
            return MemberIsValue
        }
    }

    private func ClrTypeShapeCore(clrType Type, member string) int32 {
        if ClrTypeUtilities.IsDelegateType(clrType) && InvokesDelegate(member) {
            return MemberIsValue
        }
        var shape = ClrMemberShape(clrType, member)
        if clrType.IsInterface {
            shape = shape | ClrMemberShape(typeof(object), member)
            for contract in clrType.GetInterfaces() {
                shape = shape | ClrMemberShape(contract, member)
            }
        }
        return shape
    }

    private func ClrMemberShape(type Type, member string) int32 {
        var shape = 0
        for clrMember in type.GetMember(
            member,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static |
            BindingFlags.FlattenHierarchy
        ) {
            shape = shape | ShapeOf(clrMember is MethodInfo)
        }
        return shape
    }

    private func InvokesDelegate(member string) bool -> member == "Invoke" ||
        member == "BeginInvoke" ||
        member == "DynamicInvoke"

    private func ShapeOf(isMethod bool) int32 -> if isMethod {
        MemberIsMethod
    } else {
        MemberIsValue
    }

    private func StripAllNullability(type TypeSymbol?) TypeSymbol? -> StripNullability(type)

    // The type without reference nullability and platform layers; a nullable value type keeps its `?`.
    private func StripReferenceNullability(type TypeSymbol?) TypeSymbol? {
        var current = type
        while current is NullableTypeSymbol or PlatformTypeSymbol {
            if current is NullableTypeSymbol nullable {
                if NullableLifting.IsAnyValueTypeNullable(nullable) {
                    return current
                }
                current = nullable.UnderlyingType
            } else if current is PlatformTypeSymbol platform {
                current = platform.UnderlyingType
            }
        }
        return current
    }

    private func IsNullableValueType(type TypeSymbol) bool -> type is NullableTypeSymbol nullable &&
        NullableLifting.IsAnyValueTypeNullable(nullable)

    /// Whether the fact at [`path`](paramref) is a type-test fact: the narrowed type differs from
    /// the declared type with one nullable layer removed. A member path is never one here.
    private func FactKind(path AccessPath, narrowedType TypeSymbol) string {
        if path.HasMembers {
            return "member"
        }
        let declared = StripAllNullability(path.Root.Type)
        return if declared != nil && object.Equals(declared, StripAllNullability(narrowedType)) {
            "nullability"
        } else {
            "type-test"
        }
    }

    /// Resolves a construction type name at the entry scope of the region, or `nil` when the name
    /// is a variable or a function (a callable shadowing a type name takes call binding, probe d2).
    private func ResolveConstructedType(name string) TypeSymbol? {
        let symbol = $scope.TryLookupSymbol(name)
        if symbol is VariableSymbol {
            return nil
        }
        if symbol is FunctionSymbol || !$scope.TryLookupFunctions(name).IsDefaultOrEmpty {
            return nil
        }
        if $scope.TryLookupTypeAlias(name, out var aliased) {
            return aliased
        }
        var imported ImportedClassSymbol? = nil
        if $scope.TryLookupImportedClass(name, nil, out imported) && imported != nil {
            return TypeSymbol.FromClrTypeWithoutNullability(imported.ClassType, NullabilityFreeReason.ResolvedTypeName)
        }
        return nil
    }

    // Proof rule P7 (ADR-0213 section 8) for one write to a root with a fact of the given type.
    // The write proves the nullability fact and the type-test fact separately.
    private func WriteProves(
        root VariableSymbol,
        write RegionWrite,
        narrowedType TypeSymbol,
        factKind string,
        out why string
    ) bool {
        why = "no-proof"
        if !SmartCastStability.IsAssignmentNarrowingRoot(root) || IsExternalStorageAlias(root) {
            why = "root-not-exact-storage"
            return false
        }
        if write.ViaCallArgument {
            why = "written-through-reference"
            return false
        }
        let declared = StripAllNullability(root.Type)
        switch write.Proof {
            case RegionWriteProof.NonNilLiteral {
                if declared == nil || !IsReferenceLikeType(declared) {
                    why = "literal-into-value-type"
                    return false
                }
                // A conversion operator from the literal's type can return nil, so the literal proves the fact
                // only when its value reaches the root by a reference or boxing conversion.
                if !LiteralKeepsItsValue(write.ConstructedTypeName, declared) {
                    why = "literal-converted-by-an-operator"
                    return false
                }
                // The literal proves a type-test fact only when its own type converts to the fact's type.
                let provesTypeTest = write.ConstructedTypeName == "System.String" &&
                    ConvertsImplicitly(TypeSymbol.String, narrowedType)
                if factKind == "type-test" && !provesTypeTest {
                    why = "literal-type-differs"
                    return false
                }
                return true
            }
            case RegionWriteProof.NullAssertion {
                if factKind == "type-test" {
                    why = "null-assertion-proves-nullability-only"
                    return false
                }
                // The asserted value must convert to the root without a conversion operator: a name whose type
                // keeps its representation.
                if write.RightSideName == nil || write.RightSideDeclaration != nil {
                    why = "null-assertion-of-an-unknown-value"
                    return false
                }
                if TryLookupRegionVariableType(write.RightSideName) is {} rawAssertedType {
                    let assertedType = StripAllNullability(rawAssertedType)
                    if assertedType == nil || declared == nil || !Conversion.IsRepresentationPreservingImplicit(
                        assertedType,
                        declared
                    ) {
                        why = "null-assertion-converts"
                        return false
                    }
                    return true
                }
                why = "null-assertion-of-an-unknown-value"
                return false
            }
            case RegionWriteProof.Construction {
                if write.ConstructedTypeName == nil {
                    return false
                }
                let typeName = write.ConstructedTypeName
                let callee = $scope.TryLookupSymbol(typeName)
                if callee is VariableSymbol or FunctionSymbol {
                    // A callable takes call binding before a type of the same name (probe d2).
                    why = "call"
                    return false
                }
                let constructed = ResolveConstructedType(typeName)
                if constructed == nil {
                    why = "construction-type-unresolved"
                    return false
                }
                if !IsReferenceLikeType(constructed) || constructed is NullableTypeSymbol {
                    why = "construction-of-value-type"
                    return false
                }
                if declared != nil && !ConvertsImplicitly(constructed, declared) {
                    why = "construction-type-differs"
                    return false
                }
                if factKind == "type-test" && !ConvertsImplicitly(constructed, narrowedType) {
                    why = "construction-not-the-fact-type"
                    return false
                }
                return true
            }
            default {
                if write.RightSideName != nil {
                    why = "variable"
                    // Question 4 (decided for slice L1): a type-pattern variable of the region is non-null and
                    // read-only. The scanner gives it a typed kind only where the binder scopes it; the binder
                    // drops the scope that a guard leaks (`leaked|Type`) when the function has a user label. Its
                    // type must convert to the root without a conversion operator.
                    var patternType TypeSymbol? = nil
                    var patternBound = false
                    let declaration = write.RightSideDeclaration
                    if declaration != nil && declaration.StartsWith("pattern|", StringComparison.Ordinal) {
                        patternBound = true
                        patternType = ResolveConstructedType(declaration.Substring("pattern|".Length))
                    } else if declaration != nil && declaration.StartsWith("leaked|", StringComparison.Ordinal) {
                        patternBound = true
                        if !binderCtx.FunctionContainsUserGotoOrLabel {
                            patternType = ResolveConstructedType(declaration.Substring("leaked|".Length))
                        }
                    } else if declaration == "pattern" || declaration == "binding" {
                        patternBound = true
                    }
                    if patternBound {
                        why = "variable:pattern-bound"
                        let declaredRoot = StripAllNullability(root.Type)
                        if patternType != nil && declaredRoot != nil && Conversion.IsRepresentationPreservingImplicit(
                            patternType,
                            declaredRoot
                        ) &&
                            (
                            factKind != "type-test" || Conversion.IsRepresentationPreservingImplicit(
                                patternType,
                                narrowedType
                            )
                        ) {
                            return true
                        }
                    }
                }
                return false
            }
        }
    }

    // Whether a literal of the CLR type is an instance of the target: the target is the literal's type, a base
    // class or a non-generic interface of it.
    private func LiteralKeepsItsValue(literalTypeName string?, target TypeSymbol) bool {
        if literalTypeName == nil || target.ClrType is not{} targetClr || targetClr.IsGenericType {
            return false
        }
        let literalType = Type.GetType(literalTypeName)
        if literalType == nil {
            return false
        }
        var current Type? = literalType
        while current != nil {
            if current.FullName == targetClr.FullName {
                return true
            }
            current = current.BaseType
        }
        for contract in literalType.GetInterfaces() {
            if !contract.IsGenericType && contract.FullName == targetClr.FullName {
                return true
            }
        }
        return false
    }

    private func ConvertsImplicitly(from TypeSymbol, to TypeSymbol) bool {
        // A structural projection between unrelated classes makes a new object of the other type, so only a
        // conversion that keeps the representation proves a type-test fact.
        return Conversion.IsRepresentationPreservingImplicit(from, to)
    }

    /// The consumer rule of ADR-0213 section 7, steps (i) to (vii), for one fact.
    private func DecideRegionKill(
        path AccessPath,
        narrowedType TypeSymbol,
        effects RegionEffects,
        resolved ResolvedRegionWrites,
        filterWrites List[(TryBlock SyntaxNode?, Names HashSet[string])]?
    ) RegionKillDecision {
        let root = path.Root
        // (i) the closed kind list.
        if effects.ContainsUnknownKind {
            return RegionKillDecision(true, "W6", "-")
        }
        // A user-defined operator is a call (ADR-0208 construct table).
        let callLike = effects.ContainsCall ||
            effects.ContainsSuspension ||
            effects.ContainsIteration ||
            resolved.RunsUserOperator ||
            resolved.RunsUserCodeOnWrite ||
            resolved.PatternTestsCallEquals
        // Rule W5 (#5549): a member, index or bare property read is a call unless it resolves to a member that
        // runs no user code and cannot be hidden.
        let readLike = RunsUserCodeOnMemberRead(effects, resolved)
        let memberWrite = effects.ContainsMemberWrite || effects.ContainsPointerWrite || resolved.ImplicitMemberWrite
        let mayMutateMemberPaths = callLike || readLike || memberWrite
        var indirectCall = effects.ContainsIteration || effects.ContainsSuspension
        if !indirectCall {
            if resolved.CallsAreIndirect == nil {
                var anyIndirect = false
                for call in effects.Calls {
                    if CallIsIndirect(call, effects) {
                        anyIndirect = true
                        break
                    }
                }
                resolved.CallsAreIndirect = anyIndirect
            }
            indirectCall = resolved.CallsAreIndirect == true
        }
        // Maintainer decision 2026-11-02 (the more permissive A3-wide alternative is not adopted and can be
        // revisited separately): a getter or an indexer that can run user code (ADR-0208 R14, R16 and R17) removes the fact
        // of storage that a reference names, as on main, because the code can write the storage that the
        // reference aliases. Only such a fact needs the answer, so the reads are resolved only for it.
        // The same holds for a user-defined or imported operator or conversion and a static initializer (ADR-0208
        // A3 exempts only a plain call to a method).
        if !indirectCall && NamesReferenceStorage(path) {
            if resolved.ReferenceStorageRunsUserCode == nil {
                resolved.ReferenceStorageRunsUserCode = resolved.ReadsUserCodeProperty ||
                    resolved.TouchesInitializingType ||
                    resolved.NilCompareRunsUserOperator ||
                    resolved.ConversionsRunUserCode ||
                    ReadsRunUserCode(effects, true) ||
                    OperatorsRunUserCode(effects, true) ||
                    ArgumentsRunUserConversion(effects)
            }
            indirectCall = resolved.ReferenceStorageRunsUserCode == true
        }
        // A member read is an unknown getter, which the table classes as a call (ADR-0208 R14). Amendment A3
        // (#5292) keeps the fact of a by-reference parameter across a call, so a read does not write the
        // storage that such a parameter names. It still removes member-bearing paths and the facts of an
        // alias of an element or a member.
        let mayMutateReferenceStorage = memberWrite || indirectCall
        let mayMutateAnyRoot = callLike || readLike
        let callRule = if callLike {
            "W4"
        } else if readLike {
            "W5"
        } else {
            "W3"
        }
        let callRow = if callLike {
            "R7 c"
        } else if readLike {
            "R7 e"
        } else {
            "-"
        }
        // (ii) a member-bearing path drops on a member write, a call or a member read.
        if path.HasMembers && mayMutateMemberPaths {
            return RegionKillDecision(true, callRule + "(member-path)", callRow)
        }
        // (iii) a root replacement kills every descendant path.
        var rootWritten = false
        for written in resolved.Roots {
            if SameRoot(written, root) {
                rootWritten = true
            }
        }
        if path.HasMembers && rootWritten {
            return RegionKillDecision(true, "W2(root-replaced)", "-")
        }
        // (iv) the shared predicate for every effect other than a plain write to this root.
        // A handler of the region, or one in code that the region calls, can catch an exception after an enclosing
        // filter has written the root.
        if filterWrites != nil && (effects.ContainsHandler || callLike || readLike) {
            if FilterWritesVariable(filterWrites, root) || MayBeMutatedByUnknownCallable(path) {
                return RegionKillDecision(true, "W8", "R10")
            }
        }
        // ADR-0208 amendment A3: a plain call does not kill the fact of a by-reference parameter. A callable of
        // unknown origin and user code the table lists (a getter, a constructor, a loop header) keep the full kill.
        let unknownWrite = if indirectCall {
            MayBeMutatedByUnknownWrite(mayMutateAnyRoot, effects.ContainsPointerWrite, path)
        } else {
            MayBeMutatedByUnknownWrite(
                mayMutateAnyRoot && !IsByReferenceRoot(root),
                effects.ContainsPointerWrite,
                path
            ) ||
                (mayMutateAnyRoot && MayBeMutatedByEscapedClosure(root))
        }
        if unknownWrite {
            return RegionKillDecision(
                true,
                if effects.ContainsPointerWrite {
                    "W3(pointer-write)"
                } else {
                    callRule + "(unknown-write)"
                },
                if effects.ContainsPointerWrite {
                    "-"
                } else {
                    callRow
                }
            )
        }
        if (callLike || readLike) && root is GlobalVariableSymbol && !root.IsReadOnly {
            return RegionKillDecision(true, callRule + "(global)", callRow)
        }
        if resolved.WritesViaCallArgument || indirectCall {
            if root is ParameterSymbol parameter &&
                (parameter.RefKind == RefKind.Ref || parameter.RefKind == RefKind.Out) &&
                indirectCall {
                return RegionKillDecision(true, "A3(indirect-call-on-by-reference-parameter)", "R7 c")
            }
        }
        if DropsOnMemberMutation(path, mayMutateMemberPaths, mayMutateReferenceStorage) {
            return RegionKillDecision(
                true,
                callRule + "(alias-class)",
                if mayMutateReferenceStorage && !memberWrite {
                    callRow
                } else {
                    "-"
                }
            )
        }
        for var i = 0; i < resolved.Roots.Count; i++ {
            let written = resolved.Roots[i]
            if SameRoot(written, root) {
                continue
            }
            var onlyThroughCalls = true
            for write in resolved.Writes[i] {
                if !write.ViaCallArgument {
                    onlyThroughCalls = false
                }
            }
            if onlyThroughCalls && IsCallAliasedName(effects, written.Name) {
                onlyThroughCalls = false
            }
            let shares = if onlyThroughCalls {
                ChainsOverlap(written, root)
            } else {
                MayShareStorage(written, root)
            }
            if shares {
                return RegionKillDecision(true, "W3(shares-storage)", "-")
            }
        }
        // (v) and (vi) a write to this root keeps the fact only when every write proves it (rule P7).
        for var i = 0; i < resolved.Roots.Count; i++ {
            if !SameRoot(resolved.Roots[i], root) {
                continue
            }
            let kind = FactKind(path, narrowedType)
            var allWritesProve = true
            var anyOffExitPath = false
            var firstWhy = ""
            var nullabilityStillProved = true
            for write in resolved.Writes[i] {
                if !WriteProves(root, write, narrowedType, kind, out var why) {
                    allWritesProve = false
                    if !write.FollowedByExit {
                        anyOffExitPath = true
                    }
                    if firstWhy.Length == 0 {
                        firstWhy = why
                    }
                    if !WriteProves(root, write, StripAllNullability(root.Type) ?? narrowedType, "nullability", out _) {
                        nullabilityStillProved = false
                    }
                }
            }
            if !allWritesProve {
                let row = if kind == "type-test" && nullabilityStillProved {
                    "R7 d"
                } else if anyOffExitPath {
                    "R7 b"
                } else {
                    "R7 a"
                }
                return RegionKillDecision(true, "P7(${firstWhy})", row)
            }
        }
        // (vii) otherwise keep.
        return RegionKillDecision(false, "-", "-")
    }

    /// ADR-0213 section 6 (slice L1): applies the lower bound `Lower(S, R)` of the loop whose body is
    /// [`body`](paramref) to the frames, before the header and the body are bound. `S` is the facts of the
    /// frames joined with any forward `goto` from outside the loop to a label inside it (section 6, J6),
    /// `R` the region of the loop. A fact that the consumer rule of section 7 removes leaves its
    /// frame, and stays out of it after the loop. The external callable aliases that the region may
    /// reassign leave their set.
    private func ApplyLoopEntryLowerBound(body StatementSyntax, iterationRunsUserCode bool) {
        let loop = body.Parent
        let frameCount = binderCtx.NarrowedVariables.Count
        let invalidations = List[(FrameIndex int32, Path AccessPath)]()
        if loop == nil || RegionEffectKindTable.Classify(loop.Kind) != RegionEffectClass.Loop {
            // A loop that the walker cannot name has no region to scan: every fact is removed (rule W6).
            for var i = frameCount - 1; i >= 0; i-- {
                for path in binderCtx.NarrowedVariables[i].Keys {
                    invalidations.Add((i, path))
                }
            }
            JournalLoopEntryKills(invalidations)
            InvalidateInheritedNarrowings(invalidations)
            externalCallableAliases.Clear()
            SyncExpressionCallableAliasesNow()
            CompilationMeasurements.Count("narrowing.region-facts-killed", cast[int64](invalidations.Count))
            return
        }
        JoinPendingForwardJumpsIntoNode(loop)
        if !HasAnyActiveNarrowings() && externalCallableAliases.Count == 0 {
            return
        }
        // The names that a closure of the function assigns decide the shared predicates below. They are
        // computed on first use, and until then every name is assumed assigned.
        EnsureClosureAssignedNames(loop)
        if HeaderIsLiteralFalse(loop) {
            // No back edge: the body runs once from the entry state, or never.
            return
        }
        let scanner = GetRegionScanner()
        let visitedBefore = scanner.NodesVisited
        let regionsBefore = scanner.Regions
        let effects = scanner.ScanLoop(loop, iterationRunsUserCode)
        if scanner.Regions != regionsBefore {
            CompilationMeasurements.Count("narrowing.region-walks")
            CompilationMeasurements.Count("narrowing.region-nodes", cast[int64](scanner.NodesVisited - visitedBefore))
        }
        ApplyRegionLowerBoundCore(effects, loop)
    }

    /// ADR-0213 sections 6, 7 and 13 (slices L1 and L2, #5317, #5318, #5461, #5671): the one shared
    /// application of `Lower(S, R)` to the narrowing frames and `externalCallableAliases` for a loop or a
    /// backward-jump span.
    private func ApplyRegionLowerBoundCore(effects RegionEffects, regionNode SyntaxNode) {
        EnsureClosureAssignedNames(regionNode)
        let frameCount = binderCtx.NarrowedVariables.Count
        let invalidations = List[(FrameIndex int32, Path AccessPath)]()
        let resolved = ResolveRegionWrites(effects)
        var filterWrites List[(TryBlock SyntaxNode?, Names HashSet[string])]? = nil
        if effects.ContainsHandler || RegionRunsCode(effects, resolved) {
            let filters = CollectCatchFiltersAbove(regionNode)
            if filters.Count > 0 {
                filterWrites = CollectEnclosingFilterWrites(filters)
            }
        }
        // S: the facts of the frames. A path that two frames hold is counted once, for the innermost frame.
        let reported = List[AccessPath]()
        var memberReadsWithLiveFacts = 0
        for var i = frameCount - 1; i >= 0; i-- {
            for entry in binderCtx.NarrowedVariables[i] {
                let path = entry.Key
                let decision = DecideRegionKill(path, entry.Value, effects, resolved, filterWrites)
                if decision.Killed {
                    invalidations.Add((i, path))
                }
                var seen = false
                for existing in reported {
                    if existing.Equals(path) {
                        seen = true
                        break
                    }
                }
                if seen {
                    continue
                }
                reported.Add(path)
                if decision.Killed {
                    CompilationMeasurements.Count("narrowing.region-facts-killed")
                }
                if effects.MemberReadCount > 0 && MayBeMutatedByUnknownCallable(path) {
                    memberReadsWithLiveFacts++
                }
            }
        }
        JournalLoopEntryKills(invalidations)
        InvalidateInheritedNarrowings(invalidations)
        // ADR-0213 section 13 (#5461, #5671): a function value that the region may reassign is no longer
        // external at the region entry, so a call in the region can reach a closure.
        if effects.ContainsUnknownKind || effects.ContainsPointerWrite {
            externalCallableAliases.Clear()
            binderCtx.NonNullByRefVariables.Clear()
        } else {
            if externalCallableAliases.Count > 0 {
                if resolved.Roots.Count > 0 {
                    externalCallableAliases.RemoveWhere(
                        (alias VariableSymbol) -> resolved.Roots.Any(
                            (written VariableSymbol) -> SameRoot(written, alias) || MayShareStorage(written, alias)
                        )
                    )
                }
                if RegionRunsCode(effects, resolved) {
                    externalCallableAliases.RemoveWhere(NamesClosureAssignedStorage)
                }
            }
            if binderCtx.NonNullByRefVariables.Count > 0 {
                if resolved.Roots.Count > 0 {
                    binderCtx.NonNullByRefVariables.RemoveWhere(
                        (variable VariableSymbol) -> resolved.Roots.Any(
                            (written VariableSymbol) -> SameRoot(written, variable) ||
                                MayShareStorage(written, variable)
                        )
                    )
                }
                if RegionRunsCode(effects, resolved) {
                    binderCtx.NonNullByRefVariables.RemoveWhere(NamesClosureAssignedStorage)
                }
            }
        }
        SyncExpressionCallableAliasesNow()
        if effects.MemberReadCount > 0 {
            CompilationMeasurements.Count("narrowing.region-member-reads", cast[int64](effects.MemberReadCount))
            if memberReadsWithLiveFacts > 0 {
                CompilationMeasurements.Count(
                    "narrowing.region-member-reads-with-live-facts",
                    cast[int64](effects.MemberReadCount)
                )
            }
        }
    }

    private sealed class SpanEntrySnapshot {
        init(frames[]Dictionary[AccessPath, TypeSymbol], externalCallableAliases[]VariableSymbol) {
            Frames = frames
            ExternalCallableAliases = externalCallableAliases
        }

        prop Frames[]Dictionary[AccessPath, TypeSymbol] {
            get;
        }

        prop ExternalCallableAliases[]VariableSymbol {
            get;
        }
    }

    private let spansByBody Dictionary[SyntaxNode, BackwardJumpSpan?] = Dictionary[SyntaxNode, BackwardJumpSpan?]()
    private let effectsBySpan Dictionary[BackwardJumpSpan, RegionEffects] = Dictionary[
        BackwardJumpSpan,
        RegionEffects
    ]()
    private let spanEntryStates Dictionary[BackwardJumpSpan, SpanEntrySnapshot] = Dictionary[
        BackwardJumpSpan,
        SpanEntrySnapshot
    ]()

    private func ClearBackwardJumpSpanCaches() {
        spansByBody.Clear()
        effectsBySpan.Clear()
        spanEntryStates.Clear()
    }

    private func FindEnclosingFunctionBody(node SyntaxNode) SyntaxNode? {
        for var current SyntaxNode? = cast[SyntaxNode?](node); current != nil; current = current!!.Parent {
            if current is FunctionDeclarationSyntax declaration {
                return declaration.Body
            }
            if current is FunctionLiteralExpressionSyntax literal {
                return literal.Body
            }
            if current is LambdaExpressionSyntax lambda {
                return lambda.Body
            }
            if current is ConstructorDeclarationSyntax constructor {
                return constructor.Body
            }
            if current is PropertyAccessorSyntax accessor {
                return accessor.Body
            }
            if current is EventAccessorSyntax eventAccessor {
                return eventAccessor.Body
            }
            if current is DeinitDeclarationSyntax destructor {
                return destructor.Body
            }
            if current is StaticInitializerBlockSyntax staticInit {
                return staticInit.Body
            }
            if current is GlobalStatementSyntax && current.Parent is CompilationUnitSyntax unit {
                return unit
            }
        }
        return nil
    }

    private var topLevelStatementList ImmutableArray[StatementSyntax] = ImmutableArray[StatementSyntax].Empty

    private func GetEnclosingBackwardJumpSpan(node SyntaxNode) BackwardJumpSpan? {
        if !binderCtx.FunctionContainsUserGotoOrLabel {
            return nil
        }
        let body = FindEnclosingFunctionBody(node)
        if body == nil {
            return nil
        }
        if (body is CompilationUnitSyntax || body.Parent is StaticInitializerBlockSyntax) &&
            !topLevelStatementList
            .IsDefaultOrEmpty {
            let rootKey = topLevelStatementList[0]
            if spansByBody.TryGetValue(rootKey, out var cachedTopLevel) {
                return cachedTopLevel
            }
            let topLevelSpan = BackwardJumpSpans.Compute(rootKey, topLevelStatementList)
            spansByBody[rootKey] = topLevelSpan
            if topLevelSpan != nil {
                CompilationMeasurements.Count("narrowing.spans")
            }
            return topLevelSpan
        }
        if spansByBody.TryGetValue(body, out var cached) {
            return cached
        }
        let span = BackwardJumpSpans.Compute(body)
        spansByBody[body] = span
        if span != nil {
            CompilationMeasurements.Count("narrowing.spans")
        }
        return span
    }

    private func GetSpanEffects(span BackwardJumpSpan) RegionEffects {
        if effectsBySpan.TryGetValue(span, out var cached) {
            return cached
        }
        let scanner = GetRegionScanner()
        let visitedBefore = scanner.NodesVisited
        let regionsBefore = scanner.Regions
        let effects = scanner.ScanStatements(span.Statements())
        if scanner.Regions != regionsBefore {
            CompilationMeasurements.Count("narrowing.region-walks")
            CompilationMeasurements.Count("narrowing.region-nodes", cast[int64](scanner.NodesVisited - visitedBefore))
        }
        effectsBySpan[span] = effects
        return effects
    }

    /// ADR-0213 section 11 (slice L2): when [`node`](paramref) is the first statement of the enclosing
    /// function's backward-jump span, applies `L = Lower(S, span)` before the statement is bound.
    internal func EnterBackwardJumpSpanIfFirstStatement(node SyntaxNode) {
        if !binderCtx.FunctionContainsUserGotoOrLabel {
            return
        }
        let span = GetEnclosingBackwardJumpSpan(node)
        if span == nil || !object.ReferenceEquals(span.FirstStatement, node) {
            return
        }
        ApplySpanEntryLowerBound(span)
    }

    private func ApplySpanEntryLowerBound(span BackwardJumpSpan) {
        JoinPendingForwardJumpsIntoRegion(span.Labels)
        if HasAnyActiveNarrowings() || externalCallableAliases.Count > 0 {
            ApplyRegionLowerBoundCore(GetSpanEffects(span), span.FirstStatement)
        }
        if speculativeReturnDepth > 0 {
            speculativeSpanEntryLog.Add(span)
        }
        spanEntryStates[span] = SpanEntrySnapshot(
            binderCtx
                .NarrowedVariables
                .Select((frame NarrowingFrame) -> Dictionary[AccessPath, TypeSymbol](frame))
                .ToArray(),
            externalCallableAliases.ToArray()
        )
    }

    /// ADR-0213 section 11 (slice L2, #5318, #5671): binds a participant label of [`span`](paramref) under
    /// `L = Lower(S, span)`.
    private func ApplySpanLabelLowerBound(
        span BackwardJumpSpan,
        labelName string,
        wasReachable bool,
        hadIncomingForwardJump bool
    ) {
        if !spanEntryStates.TryGetValue(span, out var entryState) {
            ApplySpanEntryLowerBound(span)
            entryState = spanEntryStates[span]
        }
        if wasReachable || hadIncomingForwardJump || span.TargetedLabels.Contains(labelName) {
            let limit = Math.Min(entryState.Frames.Length, binderCtx.NarrowedVariables.Count)
            for var i = 0; i < limit; i++ {
                let frame = binderCtx.NarrowedVariables[i]
                for entry in frame {
                    conditionKillJournal?.Add((frame, entry.Key, entry.Value))
                }
                frame.Clear()
                for entry in entryState.Frames[i] {
                    frame.Add(entry.Key, entry.Value)
                }
            }
            for var i = limit; i < binderCtx.NarrowedVariables.Count; i++ {
                let frame = binderCtx.NarrowedVariables[i]
                for entry in frame {
                    conditionKillJournal?.Add((frame, entry.Key, entry.Value))
                }
                frame.Clear()
            }
            externalCallableAliases.Clear()
            for alias in entryState.ExternalCallableAliases {
                externalCallableAliases.Add(alias)
            }
            SyncExpressionCallableAliasesNow()
        }
        JoinPendingForwardJumpsIntoRegion(span.Labels)
        if HasAnyActiveNarrowings() || externalCallableAliases.Count > 0 {
            ApplyRegionLowerBoundCore(GetSpanEffects(span), span.FirstStatement)
        }
    }

    // ADR-0213 section 6 and section 10 (J6): joins every pending forward `goto` targeting a label inside
    // `node` into the region's entry state `S`. The jumps stay in `NarrowingFlow` for the labels' own joins.
    private func JoinPendingForwardJumpsIntoNode(node SyntaxNode) {
        if !binderCtx.NarrowingFlow.HasPendingJumps {
            return
        }
        let labels = List[string]()
        CollectUserLabelsInRegion(node, labels)
        if labels.Count > 0 {
            JoinPendingForwardJumpsIntoRegion(labels)
        }
    }

    private func CollectUserLabelsInRegion(node SyntaxNode, labels List[string]) {
        if node is FunctionLiteralExpressionSyntax or
            LambdaExpressionSyntax or
            FunctionDeclarationSyntax or
            AnonymousClassExpressionSyntax {
            return
        }
        if node is LabeledStatementSyntax labeled && !IsLabelableLoop(labeled.Statement) {
            let name = labeled.LabelIdentifier.ValueText
            if !labels.Contains(name) {
                labels.Add(name)
            }
        }
        for child in node.GetChildren() {
            CollectUserLabelsInRegion(child, labels)
        }
    }

    private func JoinPendingForwardJumpsIntoRegion(labels IReadOnlyList[string]) {
        if !binderCtx.NarrowingFlow.HasPendingJumps {
            return
        }
        var incoming List[NarrowingJumpState]? = nil
        var activeFinallySet HashSet[FinallyClauseSyntax]? = nil
        var activeCleanupSet HashSet[BoundStatement]? = nil
        for labelName in labels {
            let pending = binderCtx.NarrowingFlow.PeekJumps(labelName)
            if pending == nil || pending.Count == 0 {
                continue
            }
            activeFinallySet ??= HashSet[FinallyClauseSyntax](activeFinallyClauses)
            activeCleanupSet ??= HashSet[BoundStatement](activeCleanupStatements)
            for jump in pending {
                let copy = jump.Clone()
                if ApplyExitedFinallyEffects(copy, activeFinallySet!!, activeCleanupSet!!) {
                    incoming ??= List[NarrowingJumpState]()
                    incoming!!.Add(copy)
                }
            }
        }
        if incoming != nil && incoming.Count > 0 {
            ApplyIncomingJumpJoin(incoming, currentStatementListFallsThrough)
        }
    }

    // ADR-0208 R18: a loop in a then-branch runs only on that path, so the facts that its entry removes are put back for
    // the sibling else-branch, as a condition's are (`if flag { while flag { } } else { return s.Length }`).
    private func JournalLoopEntryKills(invalidations List[(FrameIndex int32, Path AccessPath)]) {
        guard let journal = conditionKillJournal else {
            return
        }
        for (frameIndex, path) in invalidations {
            let frame = binderCtx.NarrowedVariables[frameIndex]
            if frame.TryGetValue(path, out var type) && type != nil {
                journal.Add((frame, path, type))
            }
        }
    }

    // A loop whose condition is the literal `false` has no back edge (`while false`, `do { } while false`),
    // so its body is bound under the state at its entry.
    private func HeaderIsLiteralFalse(loop SyntaxNode) bool {
        var condition ExpressionSyntax? = nil
        switch loop.Kind {
            case SyntaxKind.WhileStatement {
                condition = cast[WhileStatementSyntax](loop).Condition
            }
            case SyntaxKind.ForConditionStatement {
                condition = cast[ForConditionStatementSyntax](loop).Condition
            }
            case SyntaxKind.ForClauseStatement {
                condition = cast[ForClauseStatementSyntax](loop).Condition
            }
            case SyntaxKind.DoWhileStatement {
                condition = cast[DoWhileStatementSyntax](loop).Condition
            }
            default { }
        }
        while condition is ParenthesizedExpressionSyntax parenthesized {
            condition = parenthesized.Expression
        }
        return condition is LiteralExpressionSyntax literal && literal.LiteralToken.Kind == SyntaxKind.FalseKeyword
    }

    // The facts that the exit of a loop proves when the loop ends, by loop statement (ADR-0213 table 9, #5460).
    private let loopExitFacts Dictionary[SyntaxNode, Dictionary[AccessPath, TypeSymbol]] = Dictionary[
        SyntaxNode,
        Dictionary[AccessPath, TypeSymbol]
    ]()

    // Whether the loop header has no false exit edge (`for { }`, `for init; ; post`, `while true`, `for true`, `do { } while true`).
    private func HeaderIsUnconditional(loop SyntaxNode) bool {
        if loop.Kind == SyntaxKind.ForInfiniteStatement {
            return true
        }
        if loop is ForClauseStatementSyntax{Condition: nil} {
            return true
        }
        var condition = HeaderSyntax(loop) as ExpressionSyntax
        while condition is ParenthesizedExpressionSyntax parenthesized {
            condition = parenthesized.Expression
        }
        return condition is LiteralExpressionSyntax literal && literal.LiteralToken.Kind == SyntaxKind.TrueKeyword
    }

    private func IsLoopHeaderExitReachable(loop SyntaxNode, continueLabel BoundLabel, boundBody BoundStatement) bool {
        if HeaderIsUnconditional(loop) {
            return false
        }
        if loop.Kind == SyntaxKind.DoWhileStatement {
            return !EndsInUnconditionalExit(boundBody) ||
                HasInternallyReachableFallthrough(boundBody) ||
                internallyReachableLoopBacks.Contains(continueLabel)
        }
        return true
    }

    /// Row R7 (f) and issue #5460, table 9 column `Exit state`: the exit state of a loop is
    /// `Jmp(break, header-false)`, joining every reachable `break` state targeting the loop (after
    /// pending cleanup transfers) with the header's false state when the header exit is reachable.
    /// The header is bound under the lower bound of the loop, so each fact holds on every iteration.
    /// A fact that the condition itself may remove is dropped from the header-false state (rule A2).
    /// In a function with a user label or `goto`, loop exit lifts stay off (#4285).
    private func RecordLoopExitFacts(
        loopBody StatementSyntax,
        condition BoundExpression?,
        breakLabel BoundLabel,
        continueLabel BoundLabel,
        boundBody BoundStatement,
        loopEntryState NarrowingState,
        loopEntryAliases ImmutableArray[VariableSymbol],
        boundPost BoundStatement? = nil
    ) {
        let rawBreaks = binderCtx.NarrowingFlow.TakeBreaks(breakLabel)
        let loop = loopBody.Parent
        if loop == nil {
            return
        }
        var reachableBreaks List[NarrowingState]? = nil
        if rawBreaks != nil && rawBreaks.Count > 0 {
            let activeFinallySet = HashSet[FinallyClauseSyntax](activeFinallyClauses)
            let activeCleanupSet = HashSet[BoundStatement](activeCleanupStatements)
            for snapshot in rawBreaks {
                ApplyBreakPrefixEffects(snapshot, loopBody, boundBody, condition, loopEntryAliases, boundPost)
                if ApplyExitedFinallyEffects(snapshot, activeFinallySet, activeCleanupSet) {
                    reachableBreaks ??= List[NarrowingState](rawBreaks.Count)
                    reachableBreaks!!.Add(NarrowingState.Empty.WithAll(snapshot.GetNarrowedVariablesSnapshot()))
                }
            }
        }
        let hasBreak = reachableBreaks != nil && reachableBreaks.Count > 0
        let headerFalseReachable = IsLoopHeaderExitReachable(loop, continueLabel, boundBody)
        if (currentStatementListFallsThrough || HasInternallyReachableFallthrough(boundBody)) && headerFalseReachable {
            internallyReachableLoopExits.Add(breakLabel)
        }
        let elseFacts = if condition == nil || !headerFalseReachable {
            default(Dictionary[AccessPath, TypeSymbol]?)
        } else {
            ComputeConditionNarrowing(condition).Else
        }
        if headerFalseReachable && (elseFacts == nil || elseFacts.Count == 0) {
            return
        }
        if !headerFalseReachable && !hasBreak {
            return
        }
        if binderCtx.FunctionContainsUserGotoOrLabel {
            return
        }
        var headerFalseState = NarrowingState.Unreachable
        var survivingElseFacts Dictionary[AccessPath, TypeSymbol]? = nil
        if headerFalseReachable {
            // The effects of the header decide which facts survive it, by the same rule as the entry (A2): a call,
            // a getter, an operator, a write to the root, a write through `ref` or a filter of an enclosing try.
            let headerSyntax = HeaderSyntax(loop)
            if headerSyntax == nil {
                return
            }
            let headerEffects = GetRegionScanner().ScanStatements([]SyntaxNode{headerSyntax})
            let resolved = ResolveRegionWrites(headerEffects)
            let filters = CollectCatchFiltersAbove(loop)
            var filterWrites List[(TryBlock SyntaxNode?, Names HashSet[string])]? = nil
            if filters.Count > 0 {
                filterWrites = CollectEnclosingFilterWrites(filters)
            }
            headerFalseState = loopEntryState
            for entry in elseFacts!! {
                let path = entry.Key
                // The enclosing filters apply when the header has a handler or runs code (W8, in `DecideRegionKill`).
                let removed = DecideRegionKill(path, entry.Value, headerEffects, resolved, filterWrites).Killed
                if !removed {
                    survivingElseFacts ??= Dictionary[AccessPath, TypeSymbol]()
                    survivingElseFacts!![path] = entry.Value
                    headerFalseState = headerFalseState.With(path, entry.Value)
                }
            }
            if survivingElseFacts == nil {
                return
            }
        }
        let predecessors = List[NarrowingState]()
        if reachableBreaks != nil {
            predecessors.AddRange(reachableBreaks)
        }
        predecessors.Add(headerFalseState)
        let exitState = NarrowingState.Join(predecessors)
        if exitState.Count == 0 {
            return
        }
        let facts = Dictionary[AccessPath, TypeSymbol]()
        for path in exitState.Paths {
            if exitState.NarrowedType(path) is not{} joined {
                continue
            }
            let entryType = loopEntryState.NarrowedType(path)
            if (entryType == nil || !IsWeakerOrEqual(entryType, joined)) ||
                (survivingElseFacts != nil && survivingElseFacts.ContainsKey(path)) {
                facts[path] = joined
            }
        }
        if facts.Count > 0 {
            loopExitFacts[loop] = facts
        }
    }

    // The condition of a loop statement, or `nil`.
    private func HeaderSyntax(loop SyntaxNode) SyntaxNode? {
        switch loop.Kind {
            case SyntaxKind.WhileStatement {
                return cast[WhileStatementSyntax](loop).Condition
            }
            case SyntaxKind.ForConditionStatement {
                return cast[ForConditionStatementSyntax](loop).Condition
            }
            case SyntaxKind.ForClauseStatement {
                return cast[ForClauseStatementSyntax](loop).Condition
            }
            case SyntaxKind.DoWhileStatement {
                return cast[DoWhileStatementSyntax](loop).Condition
            }
            default {
                return nil
            }
        }
    }

    /// Adds the facts that the exit of the loop statement [`syntax`](paramref) proves to
    /// [`persistentFrame`](paramref). It runs after the statement's invalidation, which removes the
    /// roots that the body writes: the exit state is the join of the reachable exit edges.
    private func ApplyLoopExitNarrowings(syntax SyntaxNode, persistentFrame NarrowingFrame) {
        var node = syntax
        while node is LabeledStatementSyntax labeled {
            node = labeled.Statement
        }
        if !loopExitFacts.TryGetValue(node, out var facts) {
            return
        }
        loopExitFacts.Remove(node)
        for entry in facts {
            if $scope.TryLookupSymbol(entry.Key.Root.Name) is VariableSymbol inScope &&
                SameRoot(inScope, entry.Key.Root) {
                SetPersistentNarrowing(persistentFrame, entry.Key, entry.Value)
            }
        }
    }
}
