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
import System.IO
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
    private var substituteGenericStepTypes bool = false

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
            if path.RootLiteralType == "<operator>" {
                if !inOperatorsRunUserCode && !OperatorsRunUserCode(effects, false) {
                    types.Add(ReceiverType(TypeSymbol.Int32, typeof(int32)))
                } else {
                    return nil
                }
            } else {
                if Type.GetType(path.RootLiteralType) is not{} literal {
                    return nil
                }
                types.Add(ReceiverType(nil, literal))
            }
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
            if !AddClrType(ClrMethodResultType(candidate), ImmutableArray[TypeSymbol].Empty, nil, next) {
                return false
            }
        }
        return true
    }

    private func ClrMethodResultType(method MethodInfo) Type {
        let returnType = method.ReturnType
        if !ImportedFunctionSymbol.IsSuspendingMethod(method) {
            return returnType
        }
        if returnType.FullName == "System.Threading.Tasks.ValueTask" {
            return typeof(void)
        }
        if returnType.IsGenericType && returnType.GetGenericTypeDefinition()
            .FullName == "System.Threading.Tasks.ValueTask`1" {
            let args = returnType.GetGenericArguments()
            if args.Length == 1 {
                return args[0]
            }
        }
        return returnType
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
        if stripped == nil || stripped is TypeParameterSymbol {
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
                            var memberType = MemberType(candidate)
                            if substituteGenericStepTypes && memberType != nil {
                                memberType = declared.SubstituteMemberType(memberType) ?? level.SubstituteMemberType(
                                    memberType
                                ) ??
                                    memberType
                            }
                            if !AddSymbolType(memberType, next) {
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
                            var memberType = MemberType(candidate)
                            if substituteGenericStepTypes && memberType != nil {
                                memberType = contract.SubstituteMemberType(level.SubstituteMemberType(memberType))
                            }
                            if !AddSymbolType(memberType, next) {
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
                return ClrMemberVisibility.IsVisible(method, includeInternal)
            }
            default {
                return false
            }
        }
    }

    private func IsFamilyAccessibleClrBase(clrBase Type?) bool -> clrBase != nil &&
        Expressions != nil &&
        Expressions!!
        .WithFamilyAccess(ImportedClassSymbol(clrBase, declaration: nil, references: $scope.References))
        .IsFamilyAccessible(clrBase)

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
                            memberType = ClrMethodResultType(method)
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
                        allowProtectedInherited: false
                    ) {
                        found = true
                        if !AddClrType(ClrMethodResultType(method), arguments, definition, next) {
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
                    allowProtectedInherited: !staticAccess && IsFamilyAccessibleClrBase(baseClr)
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
        let allowProtectedInherited = receiver.Symbol is StructSymbol && IsFamilyAccessibleClrBase(reflected)
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

    // `nil` reaches a reference type, a nullable type or a type parameter without an operator, unless the target
    // rejects `nil` directly and takes it through a user-defined conversion operator (`func operator implicit(value string?) Token`).
    private func AcceptsNilWithoutOperator(type TypeSymbol) bool {
        let stripped = StripReferenceNullability(type) ?? type
        if !Conversion.Classify(TypeSymbol.Null, type).IsImplicit && conversions.HasUserDefinedImplicitConversion(
            TypeSymbol.Null,
            stripped
        ) {
            return false
        }
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
                IsFamilyAccessibleClrBase(reflected)
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
        if ClrTypeUtilities.IsTypeBuilderInstantiation(type) ||
            (type.IsGenericType && !type.IsGenericTypeDefinition && type.ContainsGenericParameters) {
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
        // (#5292, #5326) keeps the fact of a by-reference parameter across a call only when the call's effect
        // summary cannot write the storage that such a parameter names. It still removes member-bearing paths
        // and the facts of an alias of an element or a member.
        var callWritesReferenceStorage = false
        if !memberWrite && !indirectCall && NamesReferenceStorage(path) && !path.HasMembers {
            if EffectiveMemberRoot(path) is {} refRoot && !CallsMayWriteAliasedStorage(refRoot) {
                let chain = AliasChain(refRoot)
                let targetRoot = chain[chain.Count - 1]
                callWritesReferenceStorage = resolved.NilCompareRunsUserOperator ||
                    RegionCallsMayOverwriteRoot(effects, resolved.PatternTestsCallEquals, refRoot.Type) ||
                    (
                    !object.ReferenceEquals(targetRoot, refRoot) &&
                        RegionCallsMayOverwriteRoot(effects, resolved.PatternTestsCallEquals, targetRoot.Type)
                )
            }
        }
        let mayMutateReferenceStorage = memberWrite || indirectCall || callWritesReferenceStorage
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
        init(
            frames[]Dictionary[AccessPath, TypeSymbol],
            externalCallableAliases[]VariableSymbol,
            before NarrowingState,
            lowered NarrowingState
        ) {
            Frames = frames
            ExternalCallableAliases = externalCallableAliases
            Before = before
            Lowered = lowered
        }

        prop Frames[]Dictionary[AccessPath, TypeSymbol] {
            get;
        }

        prop ExternalCallableAliases[]VariableSymbol {
            get;
        }

        // These immutable states identify retracted reads. They do not restore flow proofs.
        prop Before NarrowingState {
            get;
        }
        prop Lowered NarrowingState {
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
        let before = binderCtx.Narrowing
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
            externalCallableAliases.ToArray(),
            before,
            binderCtx.Narrowing
        )
    }

    internal func WasNarrowedBeforeBackwardJump(syntax SyntaxNode, path AccessPath) bool {
        let span = GetEnclosingBackwardJumpSpan(syntax)
        if span == nil || !spanEntryStates.TryGetValue(span, out var entry) {
            return false
        }
        return span.Contains(syntax) && entry.Before.NarrowedType(path) != nil && entry.Lowered.NarrowedType(
            path
        ) == nil
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

    // ---------------------------------------------------------------- call-effect summaries (#5326)

    /// Issue #5326: decides whether [`callNode`](paramref) can transitively write storage that may hold
    /// a by-reference parameter of type [`rootType`](paramref).
    internal func CallEffectsMayOverwriteRoot(callNode BoundExpression, rootType TypeSymbol) bool {
        let services = binderCtx.Services
        if !services.CachedBoundCallEffectSummaries.TryGetValue(callNode, out var summary) {
            CompilationMeasurements.Count("narrowing.bound-call-effect-summaries")
            let visiting = HashSet[FunctionSymbol](ReferenceEqualityComparer.Instance)
            summary = AnalyzeBoundCallEffects(callNode, visiting)
            services.CachedBoundCallEffectSummaries[callNode] = summary
        }
        return SummaryMayOverwriteRoot(summary, rootType)
    }

    private func AnalyzeBoundCallEffects(callNode BoundExpression, visiting HashSet[FunctionSymbol]) CallEffectSummary {
        switch callNode {
            case call is BoundCallExpression {
                if call.IsConditionalElided {
                    return CallEffectSummary()
                }
                let fn = call.Function
                if (fn.MethodKind is MethodKind.PropertyGet or MethodKind.PropertySet) || IsConversionOperator(fn) {
                    let any = CallEffectSummary()
                    any.WritesAnyStorage = true
                    return any
                }
                let incOverrides = !fn.IsStatic &&
                    (
                    fn.ReceiverType is InterfaceSymbol ||
                        fn.IsOpen ||
                        fn.IsAbstract ||
                        fn.IsOverride ||
                        (
                        fn.ReceiverType is StructSymbol owner &&
                            (owner.IsOpen || owner.IsAbstract || owner.IsSealedHierarchy)
                    )
                )
                let raw = GetFunctionEffectSummaryCore(fn, incOverrides, visiting, out _)
                let receiverType = if !fn.IsStatic && fn.ReceiverType != nil {
                    fn.ReceiverType
                } else if fn.IsExtension && !call.Arguments.IsDefaultOrEmpty {
                    call.Arguments[0].Type
                } else {
                    default(TypeSymbol?)
                }
                let subst = ApplyReceiverAndMethodSubstitution(raw, receiverType, fn, call.MethodTypeArguments)
                return ResolveBoundCallCallbackEffects(subst, call.Arguments, visiting)
            }
            case uic is BoundUserInstanceCallExpression {
                let fn = uic.Method
                if (fn.MethodKind is MethodKind.PropertyGet or MethodKind.PropertySet) || IsConversionOperator(fn) {
                    let any = CallEffectSummary()
                    any.WritesAnyStorage = true
                    return any
                }
                let recvType = StripAllNullability(uic.Receiver.Type) ?? uic.Receiver.Type
                let incOverrides = recvType is InterfaceSymbol or
                    TypeParameterSymbol ||
                    fn.IsOpen ||
                    fn.IsAbstract ||
                    fn.IsOverride ||
                    (recvType is StructSymbol s && (s.IsOpen || s.IsAbstract || s.IsSealedHierarchy))
                let raw = GetFunctionEffectSummaryCore(fn, incOverrides, visiting, out _)
                let subst = ApplyReceiverAndMethodSubstitution(raw, recvType, fn, uic.MethodTypeArguments)
                return ResolveBoundCallCallbackEffects(subst, uic.Arguments, visiting)
            }
            case baseIface is BoundBaseInterfaceCallExpression {
                let fn = baseIface.Method
                let raw = GetFunctionEffectSummaryCore(fn, includeOverrides: false, visiting, out _)
                let subst = ApplyReceiverAndMethodSubstitution(
                    raw,
                    baseIface.Interface,
                    fn,
                    ImmutableArray[TypeSymbol].Empty
                )
                return ResolveBoundCallCallbackEffects(subst, baseIface.Arguments, visiting)
            }
            case baseClass is BoundBaseClassCallExpression {
                if baseClass.IsPropertyAccessor {
                    let s = CallEffectSummary()
                    if baseClass.IsSetterAccessor && baseClass.Property is {} prop {
                        s.AddFieldType(baseClass.BaseClass.SubstituteMemberType(prop.Type) ?? prop.Type)
                    }
                    return s
                }
                if baseClass.Method is {} fn {
                    let raw = GetFunctionEffectSummaryCore(fn, includeOverrides: false, visiting, out _)
                    let subst = ApplyReceiverAndMethodSubstitution(
                        raw,
                        baseClass.BaseClass,
                        fn,
                        baseClass.MethodTypeArguments
                    )
                    return ResolveBoundCallCallbackEffects(subst, baseClass.Arguments, visiting)
                }
                return CallEffectSummary()
            }
            case constrained is BoundConstrainedStaticCallExpression {
                if constrained.InterfaceMethod is {} ifaceMethod {
                    let raw = GetFunctionEffectSummaryCore(ifaceMethod, includeOverrides: true, visiting, out _)
                    let subst = ApplyReceiverAndMethodSubstitution(
                        raw,
                        constrained.ConstrainedInterfaceType,
                        ifaceMethod,
                        ImmutableArray[TypeSymbol].Empty
                    )
                    return ResolveBoundCallCallbackEffects(subst, constrained.Arguments, visiting)
                }
                if constrained.ClrMethod is {} clrMethod {
                    let argTypes = ExtractBoundArgumentTypes(constrained.Arguments)
                    let raw = AnalyzeImportedMethodEffects(
                        clrMethod,
                        constrained.ConstrainedInterfaceType,
                        argTypes,
                        constrained.TypeArgumentSymbols,
                        includeOverrides: true,
                        visiting
                    )
                    return ResolveBoundCallCallbackEffects(raw, constrained.Arguments, visiting)
                }
                return CallEffectSummary()
            }
            case impCall is BoundImportedCallExpression {
                let argTypes = ExtractBoundArgumentTypes(impCall.Arguments)
                let raw = AnalyzeImportedMethodEffects(
                    impCall.Function.Method,
                    impCall.StaticContainerType,
                    argTypes,
                    impCall.TypeArgumentSymbols,
                    includeOverrides: !impCall.Function.Method.IsStatic,
                    visiting
                )
                return ResolveBoundCallCallbackEffects(raw, impCall.Arguments, visiting)
            }
            case impInst is BoundImportedInstanceCallExpression {
                let recvType = impInst.ConstrainedInterfaceType ?? impInst.Receiver.Type
                let argTypes = ExtractBoundArgumentTypes(impInst.Arguments)
                let raw = AnalyzeImportedMethodEffects(
                    impInst.Method,
                    recvType,
                    argTypes,
                    impInst.TypeArgumentSymbols,
                    includeOverrides: !impInst.IsNonVirtualBaseCall,
                    visiting,
                    receiverHasDefaultComparer: BoundOwnedConstruction(impInst.Receiver, true)
                )
                return ResolveBoundCallCallbackEffects(raw, impInst.Arguments, visiting)
            }
            case clrStatic is BoundClrStaticCallExpression {
                let argTypes = ExtractBoundArgumentTypes(clrStatic.Arguments)
                let raw = AnalyzeImportedMethodEffects(
                    clrStatic.Method,
                    nil,
                    argTypes,
                    default(ImmutableArray[TypeSymbol?]),
                    includeOverrides: false,
                    visiting,
                    exactEnumeration: clrStatic.Arguments.All(
                        (argument BoundExpression) ->
                        argument.Type is ArrayTypeSymbol || BoundOwnedConstruction(argument, false)
                    )
                )
                return ResolveBoundCallCallbackEffects(raw, clrStatic.Arguments, visiting)
            }
            case binEq is BoundBinaryExpression {
                let eqSummary = CallEffectSummary()
                MergeEqualityOrComparerCallbackEffects(
                    "",
                    "Equals",
                    binEq.Left.Type,
                    List[TypeSymbol?]{binEq.Left.Type, binEq.Right.Type},
                    visiting,
                    eqSummary
                )
                return eqSummary
            }
            case interp is BoundInterpolatedStringExpression {
                let interpSummary = CallEffectSummary()
                if interp.Handler is {} handler {
                    var handlerCycle = false
                    let handlerType = StripAllNullability(handler.HandlerType) ?? handler.HandlerType
                    if handlerType is StructSymbol handlerStruct {
                        MergeInterpolatedStringHandlerStructEffects(
                            handlerStruct,
                            visiting,
                            interpSummary,
                            ref handlerCycle
                        )
                    } else if handlerType?.ClrType is {} hClr && !IsModeledFrameworkType(hClr, hClr.FullName ?? "") {
                        interpSummary.WritesAnyStorage = true
                        return interpSummary
                    }
                    if !handler.ForwardedArguments.IsDefaultOrEmpty {
                        MergeFormatProviderCallbackEffects(visiting, interpSummary, checkUnmodeledExternal: true)
                    }
                }
                for part in interp.Parts {
                    if part.Value is {} hole && hole.Type != TypeSymbol.String && !TypeSymbol.IsLegalPointeeType(
                        hole.Type
                    ) {
                        MergeToStringCallbackEffects(
                            "ToString",
                            hole.Type,
                            List[TypeSymbol?]{hole.Type},
                            visiting,
                            interpSummary
                        )
                    }
                }
                return interpSummary
            }
            default {
                let any = CallEffectSummary()
                any.WritesAnyStorage = true
                return any
            }
        }
    }

    private func ExtractBoundArgumentTypes(arguments ImmutableArray[BoundExpression]) List[TypeSymbol?] {
        let result = List[TypeSymbol?](arguments.Length)
        for arg in arguments {
            result.Add(arg.Type)
        }

        return result
    }

    private func BoundOwnedConstruction(expression BoundExpression, defaultComparer bool) bool {
        var current = expression
        while current is BoundConversionExpression conversion {
            current = conversion.Expression
        }
        if !defaultComparer && !HasClosedFrameworkEnumerationModel(current.Type) {
            return false
        }
        if current is BoundVariableExpression variable && variable.Variable.IsReadOnly {
            var origin = variable.Variable.DeclaringSyntax
            while origin != nil && origin is not VariableDeclarationSyntax {
                origin = origin.Parent
            }
            if origin is VariableDeclarationSyntax declaration && !declaration.HasRefKindModifier {
                return if defaultComparer {
                    IsDefaultCallbackConstructionSyntax(declaration.Initializer)
                } else {
                    IsCalleeFreshAllocationSyntax(declaration.Initializer)
                }
            }
        }
        return current.Syntax is ExpressionSyntax syntax &&
            (
            if defaultComparer {
                IsDefaultCallbackConstructionSyntax(syntax)
            } else {
                IsCalleeFreshAllocationSyntax(syntax)
            }
        )
    }

    private func HasClosedFrameworkEnumerationModel(type TypeSymbol?) bool {
        let stripped = StripAllNullability(type) ?? type
        if stripped is ArrayTypeSymbol {
            return true
        }
        if stripped?.ClrType is not{} clr {
            return false
        }
        let name = (
            if clr.IsGenericType {
                clr.GetGenericTypeDefinition()
            } else {
                clr
            }
        ).FullName ??
            ""
        return IsMutableGenericContainerTypeName(name) && IsModeledFrameworkType(clr, name)
    }

    private func IsDefaultCallbackConstructionSyntax(expression ExpressionSyntax?) bool {
        var current = expression
        while current is ParenthesizedExpressionSyntax parent {
            current = parent.Expression
        }
        return current is CallExpressionSyntax call &&
            call
            .Arguments
            .Count == 0 &&
            IsCalleeFreshAllocationSyntax(current)
    }

    private func ResolveBoundCallCallbackEffects(
        summary CallEffectSummary,
        arguments ImmutableArray[BoundExpression],
        visiting HashSet[FunctionSymbol]
    ) CallEffectSummary {
        if !summary.InvokesCallbackParameter || summary.WritesAnyStorage {
            return summary
        }
        let resolved = CallEffectSummary()
        resolved.MergeFrom(summary)
        resolved.InvokesCallbackParameter = false
        var sawCallableArg = false
        for rawArg in arguments {
            var arg = rawArg
            while arg is BoundConversionExpression conv {
                arg = conv.Expression
            }
            if !IsCallableMemberType(arg.Type) && arg is not BoundFunctionLiteralExpression {
                continue
            }
            sawCallableArg = true
            if arg is BoundFunctionLiteralExpression fnLit && fnLit.Syntax != nil {
                let lambdaBody SyntaxNode? = (fnLit.Syntax as LambdaExpressionSyntax)?.Body ??
                    (fnLit.Syntax as FunctionLiteralExpressionSyntax)?.Body
                if lambdaBody == nil {
                    resolved.WritesAnyStorage = true
                    return resolved
                }
                let emptyParams = Dictionary[string, ParameterSymbol](StringComparer.Ordinal)
                let emptyTypeParams = Dictionary[string, TypeParameterSymbol](StringComparer.Ordinal)
                let localTypes = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                let refLocals = HashSet[string](StringComparer.Ordinal)
                let refExt = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                let localFns = Dictionary[string, SyntaxNode](StringComparer.Ordinal)
                let visitingLocalFns = HashSet[string](StringComparer.Ordinal)
                let dummyFn = FunctionSymbol("<lambda>", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void)
                var hitCycle = false
                ScanCalleeSyntaxNode(
                    lambdaBody,
                    nil,
                    false,
                    dummyFn,
                    nil,
                    false,
                    emptyParams,
                    emptyTypeParams,
                    localTypes,
                    refLocals,
                    refExt,
                    localFns,
                    visitingLocalFns,
                    visiting,
                    resolved,
                    ref hitCycle
                )
            } else {
                resolved.WritesAnyStorage = true
                return resolved
            }
        }
        if !sawCallableArg {
            return resolved
        }
        return resolved
    }

    private func RegionCallsMayOverwriteRoot(
        effects RegionEffects,
        patternTestsCallEquals bool,
        rootType TypeSymbol
    ) bool {
        if effects.Calls.Count == 0 && effects.Operators.Count == 0 && !patternTestsCallEquals {
            return false
        }
        let visiting = HashSet[FunctionSymbol](ReferenceEqualityComparer.Instance)
        if patternTestsCallEquals {
            let patSummary = CallEffectSummary()
            MergeEqualityOrComparerCallbackEffects("", "Equals", TypeSymbol.Object, nil, visiting, patSummary)
            if SummaryMayOverwriteRoot(patSummary, rootType) {
                return true
            }
        }
        for op in effects.Operators {
            let opTypes = List[TypeSymbol?]()
            for operand in op.Operands {
                if operand != nil &&
                    ResolveReceiverPath(operand, effects) is {} resolvedTypes &&
                    resolvedTypes.Count > 0 {
                    for rt in resolvedTypes {
                        opTypes.Add(rt.Symbol)
                    }
                } else {
                    opTypes.Add(nil)
                }
            }
            let opSummary = CallEffectSummary()
            if op.Kind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken {
                let firstType = if opTypes.Count > 0 {
                    opTypes[0]
                } else {
                    default(TypeSymbol?)
                }
                MergeEqualityOrComparerCallbackEffects("", "Equals", firstType, opTypes, visiting, opSummary)
            }
            let opMethodName = if op.Operands.Count == 1 {
                if OperatorNames.TryGetUnaryName(op.Kind) is {} uName {
                    uName
                } else {
                    ""
                }
            } else {
                if OperatorNames.TryGetBinaryName(op.Kind) is {} bName {
                    bName
                } else {
                    ""
                }
            }
            if opMethodName.Length > 0 {
                for ot in opTypes {
                    let strippedOt = StripAllNullability(ot) ?? ot
                    if strippedOt is StructSymbol opStruct {
                        for sm in opStruct.StaticMethods {
                            if sm.Name == opMethodName {
                                opSummary.MergeFrom(
                                    GetFunctionEffectSummaryCore(sm, includeOverrides: false, visiting, out _)
                                )
                            }
                        }
                    }
                    if strippedOt != nil {
                        for extFn in $scope.TryLookupExtensionFunctions(strippedOt, opMethodName) {
                            opSummary.MergeFrom(
                                GetFunctionEffectSummaryCore(extFn, includeOverrides: false, visiting, out _)
                            )
                        }
                    }
                }
            }
            if SummaryMayOverwriteRoot(opSummary, rootType) {
                return true
            }
        }
        for call in effects.Calls {
            if RegionSingleCallMayOverwriteRoot(call, effects, rootType, visiting) {
                return true
            }
        }
        return false
    }

    private func RegionSingleCallMayOverwriteRoot(
        call RegionCall,
        effects RegionEffects,
        rootType TypeSymbol,
        visiting HashSet[FunctionSymbol]
    ) bool {
        if call.Kind == RegionCallKind.NamedInvocation {
            if call.CalleeName is not{} name {
                return true
            }
            return NamedCallCandidatesMayOverwriteRoot(name, nil, rootType, visiting)
        }
        if call.Kind == RegionCallKind.MemberInvocation {
            if call.CalleeName is not{} member {
                return true
            }
            var receivers List[ReceiverType]? = nil
            if call.ReceiverName is {} receiverName {
                receivers = ResolveNamedReceiverTypesForEffects(receiverName, effects)
            } else if call.Receiver is {} path {
                let savedSubst = substituteGenericStepTypes
                try {
                    substituteGenericStepTypes = true
                    receivers = ResolveReceiverPath(path, effects)
                } finally {
                    substituteGenericStepTypes = savedSubst
                }
            }
            guard let resolved = receivers else {
                return true
            }
            if resolved.Count == 0 {
                return true
            }
            let staticAccess = ReceiverNamesType(call)
            let argTypes = ResolveRegionCallArgumentTypes(call, effects)
            var foundAnyCandidate = false
            for receiver in resolved {
                if ReceiverMethodMayOverwriteRoot(
                    receiver,
                    member,
                    staticAccess,
                    argTypes,
                    rootType,
                    visiting,
                    out var matchedOnReceiver
                ) {
                    return true
                }
                if matchedOnReceiver {
                    foundAnyCandidate = true
                }
            }
            if !staticAccess {
                for receiver in resolved {
                    if receiver.Symbol is {} recvSym {
                        let extFns = $scope.TryLookupExtensionFunctions(recvSym, member)
                        if !extFns.IsDefaultOrEmpty {
                            foundAnyCandidate = true
                            for extFn in extFns {
                                let raw = GetFunctionEffectSummaryCore(extFn, includeOverrides: false, visiting, out _)
                                let subst = ApplyReceiverAndMethodSubstitution(
                                    raw,
                                    recvSym,
                                    extFn,
                                    ImmutableArray[TypeSymbol].Empty
                                )
                                if SummaryMayOverwriteRoot(subst, rootType) {
                                    return true
                                }
                            }
                        }
                    }
                }
                if !foundAnyCandidate {
                    let recvSym0 = resolved[0].Symbol
                    let importedExts = MemberLookup(binderCtx).CollectImportedExtensionMethods(member)
                    for impExt in importedExts {
                        let extParams = impExt.GetParameters()
                        if extParams.Length != call.Arguments.Count + 1 && !extParams.Any(
                            (p ParameterInfo) -> p.IsOptional || ClrOverloadResolution.IsParamsArrayParameter(p)
                        ) {
                            continue
                        }
                        if extParams.Length > 0 && !ClrExtensionReceiverCanApply(recvSym0, extParams[0].ParameterType) {
                            continue
                        }
                        foundAnyCandidate = true
                        let summary = AnalyzeImportedMethodEffects(
                            impExt,
                            recvSym0,
                            argTypes,
                            default(ImmutableArray[TypeSymbol?]),
                            includeOverrides: false,
                            visiting
                        )
                        if SummaryMayOverwriteRoot(summary, rootType) {
                            return true
                        }
                    }
                }
            }
            return !foundAnyCandidate
        }
        return true
    }

    private func ClrExtensionReceiverCanApply(receiver TypeSymbol?, parameter Type) bool {
        let actual = receiver?.ClrType
        if actual == nil {
            return true
        }
        let parameter = if parameter.IsByRef {
            parameter.GetElementType() ?? parameter
        } else {
            parameter
        }
        if parameter.IsGenericParameter {
            return true
        }
        try {
            let openType = if parameter.IsGenericType {
                parameter.GetGenericTypeDefinition()
            } else {
                parameter
            }
            if openType.IsInterface {
                return ClrTypeMatchesOrImplementsInterface(actual, openType)
            }
            if openType.IsClass {
                return ClrTypeDerivesFromClass(actual, openType)
            }
            return true
        } catch (error NotSupportedException) {
            return true
        }
    }

    private func ResolveNamedReceiverTypesForEffects(name string, effects RegionEffects) List[ReceiverType]? {
        let types = List[ReceiverType]()
        let symbol = $scope.TryLookupSymbol(name)
        if symbol is VariableSymbol receiver {
            if StripAllNullability(receiver.Type) is {} declared {
                types.Add(ReceiverType(declared, nil))
            }
            if StripAllNullability(binderCtx.NarrowedVariables.Query(AccessPath.ForVariable(receiver))) is {} narrowed {
                types.Add(ReceiverType(narrowed, nil))
            }
            for test in effects.TypeTests {
                if test.Name == name {
                    if TestedTypeWithArguments(test, out var testsConstant) is {} tested {
                        types.Add(ReceiverType(tested, nil))
                    } else if !testsConstant {
                        return nil
                    }
                }
            }
            return if types.Count > 0 {
                Distinct(types)
            } else {
                default(List[ReceiverType]?)
            }
        }
        if TryResolveBareFallbackMember(name, out var fallbackType, out _, out _, out _) &&
            StripAllNullability(fallbackType) is {} strippedFallback {
            types.Add(ReceiverType(strippedFallback, nil))
        }
        if ResolveTypeName(name) is {} named {
            types.Add(ReceiverType(named, nil))
        }
        return if types.Count > 0 {
            Distinct(types)
        } else {
            default(List[ReceiverType]?)
        }
    }

    private func TestedTypeWithArguments(test RegionTypeTest, out testsConstant bool) TypeSymbol? {
        let baseType = TestedType(test, out testsConstant)
        if baseType == nil || test.TypeClause == nil || test.Arity == 0 {
            return baseType
        }
        return ConstructTypeWithClauseArguments(baseType, test.TypeClause, nil) ?? baseType
    }

    private func ConstructTypeWithClauseArguments(
        baseType TypeSymbol,
        clause TypeClauseSyntax?,
        calleeTypeParams Dictionary[string, TypeParameterSymbol]?
    ) TypeSymbol? {
        if clause?.TypeArguments is not{} argSyntaxes || argSyntaxes.Count == 0 {
            return baseType
        }
        let typeArgs = ImmutableArray.CreateBuilder[TypeSymbol](argSyntaxes.Count)
        for argSyntax in argSyntaxes {
            guard let resolvedArg = ResolveCalleeTypeClause(argSyntax, calleeTypeParams) else {
                return baseType
            }
            typeArgs.Add(resolvedArg)
        }
        let args = typeArgs.MoveToImmutable()
        if baseType is StructSymbol s {
            let def = s.Definition ?? s
            if def.TypeParameters.Length == args.Length {
                return StructSymbol.Construct(def, args)
            }
        }
        if baseType is InterfaceSymbol iface {
            let def = iface.Definition ?? iface
            if def.TypeParameters.Length == args.Length {
                return InterfaceSymbol.Construct(def, args)
            }
        }
        if baseType.ClrType is {} clr {
            let openClr = if clr.IsGenericTypeDefinition {
                clr
            } else if clr.IsGenericType {
                clr.GetGenericTypeDefinition()
            } else {
                default(Type?)
            }
            if openClr != nil && openClr.GetGenericArguments().Length == args.Length {
                return ImportedTypeSymbol.GetConstructed(openClr, openClr, args)
            }
        }
        return baseType
    }

    private func ResolveRegionCallArgumentTypes(call RegionCall, effects RegionEffects) List[TypeSymbol?]? {
        if call.Arguments.Count == 0 {
            return nil
        }
        let needsOperatorResults = call.ArgumentForms.Any(
            (form RegionArgumentForm) ->
            form is RegionArgumentForm.StringByForm or RegionArgumentForm.BuiltInByForm
        )
        let operatorResultsKnown = !needsOperatorResults ||
            (!inOperatorsRunUserCode && !OperatorsRunUserCode(effects, false))
        if TryBuildCallArgumentInfo(
            call.Arguments,
            call.ArgumentForms,
            call.Syntax,
            effects,
            operatorResultsKnown,
            out var typedArguments,
            out _,
            out _
        ) {
            let typed = List[TypeSymbol?](typedArguments.Count)
            for alternatives in typedArguments {
                typed.Add(
                    if alternatives != nil && alternatives.Count == 1 {
                        alternatives[0]
                    } else {
                        default(TypeSymbol?)
                    }
                )
            }
            return typed
        }
        let result = List[TypeSymbol?](call.Arguments.Count)
        for argPath in call.Arguments {
            if argPath != nil && ConversionTypes(argPath, effects) is {} convTypes && convTypes.Count > 0 {
                result.Add(convTypes[0])
            } else {
                result.Add(nil)
            }
        }
        return result
    }

    private func NamedCallCandidatesMayOverwriteRoot(
        name string,
        argTypes List[TypeSymbol?]?,
        rootType TypeSymbol,
        visiting HashSet[FunctionSymbol]
    ) bool {
        var found = false
        let owner = function?.ReceiverType ?? function?.StaticOwnerType ?? function?.LexicalEnclosingType
        if owner != nil &&
            NamedMemberCandidatesOnOwnerMayOverwriteRoot(
            owner,
            name,
            argTypes,
            rootType,
            visiting,
            out var ownerFound
        ) {
            return true
        }
        if owner != nil {
            found = found || ownerFound
        }
        let scopeFunctions = $scope.TryLookupFunctions(name)
        if !scopeFunctions.IsDefaultOrEmpty {
            found = true
            for fn in scopeFunctions {
                let incOverrides = !fn.IsStatic &&
                    (fn.ReceiverType is InterfaceSymbol || fn.IsOpen || fn.IsAbstract || fn.IsOverride)
                let summary = GetFunctionEffectSummaryCore(fn, incOverrides, visiting, out _)
                if SummaryMayOverwriteRoot(summary, rootType) {
                    return true
                }
            }
        }
        for importedType in binderCtx.GetStaticImportTypes() {
            for method in importedType.StaticMethods {
                if method.Name == name {
                    found = true
                    let summary = GetFunctionEffectSummaryCore(method, includeOverrides: false, visiting, out _)
                    if SummaryMayOverwriteRoot(summary, rootType) {
                        return true
                    }
                }
            }
        }
        for clrType in $scope.EnumerateStaticImportClrTypes() {
            if ReflectionType(clrType) is {} reflected {
                for member in reflected.GetMember(
                    name,
                    BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy
                ) {
                    if member is MethodInfo clrMethod {
                        found = true
                        let summary = AnalyzeImportedMethodEffects(
                            clrMethod,
                            nil,
                            argTypes,
                            default(ImmutableArray[TypeSymbol?]),
                            includeOverrides: false,
                            visiting
                        )
                        if SummaryMayOverwriteRoot(summary, rootType) {
                            return true
                        }
                    }
                }
            }
        }
        return !found
    }

    private func NamedMemberCandidatesOnOwnerMayOverwriteRoot(
        owner TypeSymbol,
        name string,
        argTypes List[TypeSymbol?]?,
        rootType TypeSymbol,
        visiting HashSet[FunctionSymbol],
        out found bool
    ) bool {
        found = false
        switch owner {
            case s is StructSymbol {
                for level in s.GetHierarchy() {
                    for m in level.Methods {
                        if m.Name == name {
                            found = true
                            let incOverrides = s.IsOpen ||
                                s.IsAbstract ||
                                s.IsSealedHierarchy ||
                                m.IsOpen ||
                                m.IsAbstract ||
                                m.IsOverride
                            let raw = GetFunctionEffectSummaryCore(m, incOverrides, visiting, out _)
                            let subst = ApplyReceiverAndMethodSubstitution(raw, s, m, ImmutableArray[TypeSymbol].Empty)
                            if SummaryMayOverwriteRoot(subst, rootType) {
                                return true
                            }
                        }
                    }
                    for m in level.StaticMethods {
                        if m.Name == name {
                            found = true
                            let raw = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out _)
                            let subst = ApplyReceiverAndMethodSubstitution(raw, s, m, ImmutableArray[TypeSymbol].Empty)
                            if SummaryMayOverwriteRoot(subst, rootType) {
                                return true
                            }
                        }
                    }
                }
                if s.GetHierarchy().Last().ImportedBaseType is {} impBase {
                    if ReceiverMethodMayOverwriteRoot(
                        ReceiverType(impBase, nil),
                        name,
                        false,
                        argTypes,
                        rootType,
                        visiting,
                        out var impFound
                    ) {
                        return true
                    }
                    found = found || impFound
                }
            }
            case iface is InterfaceSymbol {
                for level in iface.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    for m in level.GetMethods(name) {
                        found = true
                        let raw = GetFunctionEffectSummaryCore(m, includeOverrides: true, visiting, out _)
                        let subst = ApplyReceiverAndMethodSubstitution(raw, iface, m, ImmutableArray[TypeSymbol].Empty)
                        if SummaryMayOverwriteRoot(subst, rootType) {
                            return true
                        }
                    }
                    for m in level.GetStaticMethods(name) {
                        found = true
                        let raw = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out _)
                        let subst = ApplyReceiverAndMethodSubstitution(raw, iface, m, ImmutableArray[TypeSymbol].Empty)
                        if SummaryMayOverwriteRoot(subst, rootType) {
                            return true
                        }
                    }
                }
            }
            default { }
        }
        return false
    }

    private func ReceiverMethodMayOverwriteRoot(
        receiver ReceiverType,
        member string,
        staticAccess bool,
        argTypes List[TypeSymbol?]?,
        rootType TypeSymbol,
        visiting HashSet[FunctionSymbol],
        out matched bool
    ) bool {
        matched = false
        var clrType = receiver.Clr
        var symbolic = receiver.Symbol
        switch receiver.Symbol {
            case declared is StructSymbol {
                let canHaveSubclass = declared.IsClass &&
                    (declared.IsOpen || declared.IsAbstract || declared.IsSealedHierarchy)
                for level in declared.GetHierarchy() {
                    let methods = if staticAccess {
                        level.StaticMethods
                    } else {
                        level.Methods
                    }
                    for m in methods {
                        if m.Name == member {
                            matched = true
                            let incOverrides = !staticAccess &&
                                (canHaveSubclass || m.IsOpen || m.IsAbstract || m.IsOverride)
                            let raw = GetFunctionEffectSummaryCore(m, incOverrides, visiting, out _)
                            let subst = ApplyReceiverAndMethodSubstitution(
                                raw,
                                declared,
                                m,
                                ImmutableArray[TypeSymbol].Empty
                            )
                            if SummaryMayOverwriteRoot(subst, rootType) {
                                return true
                            }
                        }
                    }
                }
                let importedBase = declared.GetHierarchy().Last().ImportedBaseType
                if importedBase != nil {
                    if ReceiverMethodMayOverwriteRoot(
                        ReceiverType(importedBase, nil),
                        member,
                        staticAccess,
                        argTypes,
                        rootType,
                        visiting,
                        out var baseMatched
                    ) {
                        return true
                    }
                    matched = matched || baseMatched
                }
                clrType = typeof(object)
                symbolic = declared
            }
            case contract is InterfaceSymbol {
                for level in contract.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    let functions = if staticAccess {
                        level.GetStaticMethods(member)
                    } else {
                        level.GetMethods(member)
                    }
                    for m in functions {
                        matched = true
                        let raw = GetFunctionEffectSummaryCore(m, includeOverrides: !staticAccess, visiting, out _)
                        let subst = ApplyReceiverAndMethodSubstitution(
                            raw,
                            contract,
                            m,
                            ImmutableArray[TypeSymbol].Empty
                        )
                        if SummaryMayOverwriteRoot(subst, rootType) {
                            return true
                        }
                    }
                    for clrBase in level.BaseClrInterfaces {
                        if ReceiverMethodMayOverwriteRoot(
                            ReceiverType(clrBase, nil),
                            member,
                            staticAccess,
                            argTypes,
                            rootType,
                            visiting,
                            out var clrBaseMatched
                        ) {
                            return true
                        }
                        matched = matched || clrBaseMatched
                    }
                }
                clrType = typeof(object)
                symbolic = contract
            }
            case tp is TypeParameterSymbol {
                let seenTp = HashSet[TypeParameterSymbol]()
                var cur TypeParameterSymbol? = tp
                while cur != nil && seenTp.Add(cur) {
                    if cur.InterfaceConstraint is {} ic {
                        if ReceiverMethodMayOverwriteRoot(
                            ReceiverType(ic, nil),
                            member,
                            staticAccess,
                            argTypes,
                            rootType,
                            visiting,
                            out var m1
                        ) {
                            return true
                        }
                        matched = matched || m1
                    }
                    if cur.ClrInterfaceConstraint is {} cic {
                        if ReceiverMethodMayOverwriteRoot(
                            ReceiverType(cic, nil),
                            member,
                            staticAccess,
                            argTypes,
                            rootType,
                            visiting,
                            out var m2
                        ) {
                            return true
                        }
                        matched = matched || m2
                    }
                    if cur.ClassConstraint is {} cc {
                        if ReceiverMethodMayOverwriteRoot(
                            ReceiverType(cc, nil),
                            member,
                            staticAccess,
                            argTypes,
                            rootType,
                            visiting,
                            out var m3
                        ) {
                            return true
                        }
                        matched = matched || m3
                    }
                    cur = cur.TypeParameterBound
                }
                clrType = typeof(object)
                symbolic = tp
            }
            case EnumSymbol {
                clrType = typeof(Enum)
                symbolic = receiver.Symbol
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
            return false
        }
        try {
            let searched = List[Type]()
            searched.Add(reflected)
            if reflected.IsInterface {
                searched.AddRange(reflected.GetInterfaces())
                searched.Add(typeof(object))
            }
            let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
            for searchedType in searched {
                for clrMember in searchedType.GetMember(member, flags) {
                    if clrMember is MethodInfo clrMethod && clrMethod.IsStatic == staticAccess {
                        let clrParams = clrMethod.GetParameters()
                        if argTypes != nil && clrParams.Length != argTypes.Count && !clrParams.Any(
                            (p ParameterInfo) -> p.IsOptional || ClrOverloadResolution.IsParamsArrayParameter(p)
                        ) {
                            continue
                        }
                        matched = true
                        let summary = AnalyzeImportedMethodEffects(
                            clrMethod,
                            symbolic,
                            argTypes,
                            default(ImmutableArray[TypeSymbol?]),
                            includeOverrides: !staticAccess,
                            visiting
                        )
                        if SummaryMayOverwriteRoot(summary, rootType) {
                            return true
                        }
                    }
                }
            }
        } catch (ex NotSupportedException) {
            return true
        }
        return false
    }

    private func SameInterfacesSnapshot(
        cached ImmutableArray[InterfaceSymbol],
        current ImmutableArray[InterfaceSymbol]
    ) bool {
        if cached.IsDefault != current.IsDefault {
            return false
        }
        if cached.IsDefault {
            return true
        }
        if cached.Equals(current) {
            return true
        }
        if cached.Length != current.Length {
            return false
        }
        for var i = 0; i < cached.Length; i++ {
            if !object.ReferenceEquals(cached[i], current[i]) {
                return false
            }
        }
        return true
    }

    private func GetCompilationMethodsByName() Dictionary[string, ImmutableArray[FunctionSymbol]] {
        let structs = binderCtx.RootScope.GetDeclaredStructs()
        let interfaces = binderCtx.RootScope.GetDeclaredInterfaces()
        let services = binderCtx.Services
        if services.HasCachedMethodsByName &&
            services.CachedMethodsByName != nil &&
            services
            .CachedMethodsByNameStructs
            .Equals(structs) && SameInterfacesSnapshot(services.CachedMethodsByNameInterfaces, interfaces) {
            return services.CachedMethodsByName!!
        }
        let builders = Dictionary[string, ImmutableArray[FunctionSymbol].Builder](StringComparer.Ordinal)
        for s in structs {
            for method in s.Methods {
                AddMethodToNameIndex(builders, method)
            }
            for method in s.StaticMethods {
                AddMethodToNameIndex(builders, method)
            }
            for prop in s.Properties {
                if prop.GetterSymbol is {} getter {
                    AddMethodToNameIndex(builders, getter)
                }
                if prop.SetterSymbol is {} setter {
                    AddMethodToNameIndex(builders, setter)
                }
            }
            for prop in s.StaticProperties {
                if prop.GetterSymbol is {} getter {
                    AddMethodToNameIndex(builders, getter)
                }
                if prop.SetterSymbol is {} setter {
                    AddMethodToNameIndex(builders, setter)
                }
            }
        }
        for iface in interfaces {
            iface.EnsureMembersResolved()
            for method in iface.Methods {
                AddMethodToNameIndex(builders, method)
            }
            for method in iface.StaticMethods {
                AddMethodToNameIndex(builders, method)
            }
            for prop in iface.Properties {
                if prop.GetterSymbol is {} getter {
                    AddMethodToNameIndex(builders, getter)
                }
                if prop.SetterSymbol is {} setter {
                    AddMethodToNameIndex(builders, setter)
                }
            }
        }
        let result = Dictionary[string, ImmutableArray[FunctionSymbol]](StringComparer.Ordinal)
        for entry in builders {
            result[entry.Key] = entry.Value.ToImmutable()
        }
        services.CachedMethodsByName = result
        services.CachedMethodsByNameStructs = structs
        services.CachedMethodsByNameInterfaces = interfaces
        services.HasCachedMethodsByName = true
        return result
    }

    private func AddMethodToNameIndex(
        builders Dictionary[string, ImmutableArray[FunctionSymbol].Builder],
        method FunctionSymbol
    ) {
        if !builders.TryGetValue(method.Name, out var builder) {
            builder = ImmutableArray.CreateBuilder[FunctionSymbol]()
            builders[method.Name] = builder
        }
        builder.Add(method)
    }

    private var isComputingEqualityCallbacks bool = false
    private var isComputingToStringCallbacks bool = false

    private func CallbackOwnerMayMatchValueType(ownerType TypeSymbol?, valueType TypeSymbol?) bool {
        let owner = StripAllNullability(ownerType) ?? ownerType
        let val = StripAllNullability(valueType) ?? valueType
        if owner == nil || val == nil {
            return true
        }
        if object.Equals(val, TypeSymbol.Object) || val == TypeSymbol.Error {
            return true
        }
        if val is TypeParameterSymbol tp {
            return TypeParameterMayHoldRoot(tp, owner, isElement: false, nil)
        }
        if val is InterfaceSymbol {
            return ByReferenceTypesMayOverlap(val, owner)
        }
        if val is StructSymbol {
            return Conversion.IsRepresentationPreservingImplicit(owner, val) ||
                Conversion.IsRepresentationPreservingImplicit(val, owner)
        }
        if val is ImportedTypeSymbol {
            if val.ClrType is {} clr && (clr.IsInterface || (!clr.IsSealed && !clr.IsValueType)) {
                return Conversion.IsRepresentationPreservingImplicit(owner, val)
            }
            return false
        }
        return false
    }

    private func AddComparedTypeWithTupleElements(
        list List[TypeSymbol?],
        type TypeSymbol?,
        visited HashSet[StructSymbol]? = nil
    ) {
        list.Add(type)
        guard let stripped = StripAllNullability(type) ?? type else {
            return
        }
        var clrName = ""
        if let clr = stripped.ClrType {
            clrName = (
                if clr.IsGenericType {
                    clr.GetGenericTypeDefinition()
                } else {
                    clr
                }
            ).FullName ??
                ""
        }
        if stripped is TupleTypeSymbol || clrName == "System.Nullable`1" || clrName.StartsWith(
            "System.ValueTuple`",
            StringComparison.Ordinal
        ) ||
            clrName
            .StartsWith("System.Tuple`", StringComparison.Ordinal) {
            for elem in stripped.GetElementPositions() {
                AddComparedTypeWithTupleElements(list, elem, visited)
            }
        } else if stripped is StructSymbol structural && (structural.IsData || structural.IsInline) {
            let seen = visited ?? HashSet[StructSymbol](ReferenceEqualityComparer.Instance)
            if seen.Add(structural.Definition ?? structural) {
                for f in structural.Fields {
                    if !f.IsStatic {
                        AddComparedTypeWithTupleElements(list, structural.SubstituteMemberType(f.Type) ?? f.Type, seen)
                    }
                }
                for p in structural.Properties {
                    if !p.IsStatic && !p.IsIndexer {
                        AddComparedTypeWithTupleElements(list, structural.SubstituteMemberType(p.Type) ?? p.Type, seen)
                    }
                }
            }
        }
    }

    private func MergeEqualityOrComparerCallbackEffects(
        declFullName string,
        methodName string,
        receiverType TypeSymbol?,
        argumentTypes List[TypeSymbol?]?,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        comparerKinds int32 = 0,
        defaultComparer bool = false
    ) {
        let isOrdered = (
            methodName is "Sort" or
                "BinarySearch" or
                "Compare" or
                "CompareTo" or
                "Min" or
                "Max" or
                "MinBy" or
                "MaxBy" or
                "Order" or
                "OrderDescending" or
                "OrderBy" or
                "OrderByDescending" or
                "ThenBy" or
                "ThenByDescending"
        ) ||
            declFullName.StartsWith("System.Collections.Generic.Sorted", StringComparison.Ordinal) ||
            declFullName.StartsWith("System.Collections.Generic.PriorityQueue`", StringComparison.Ordinal)
        let comparedTypes = List[TypeSymbol?]()
        if receiverType != nil {
            let strippedRecv = StripAllNullability(receiverType) ?? receiverType
            if GetContainerSlotTypes(strippedRecv) is {} slots && slots.Count > 0 {
                AddComparedTypeWithTupleElements(
                    comparedTypes,
                    slots[GetComparedContainerSlotIndex(declFullName, methodName, slots.Count)].SlotType
                )
            } else if strippedRecv is ImportedTypeSymbol imp && !imp.TypeArguments.IsDefaultOrEmpty {
                AddComparedTypeWithTupleElements(
                    comparedTypes,
                    imp.TypeArguments[GetComparedContainerSlotIndex(declFullName, methodName, imp.TypeArguments.Length)]
                )
            } else if declFullName != "System.Object" && declFullName != "System.Array" {
                AddComparedTypeWithTupleElements(comparedTypes, strippedRecv)
            }
        }
        if argumentTypes != nil &&
            (comparedTypes.Count == 0 || methodName is "Equals" or "SequenceEqual" or "Compare" or "CompareTo") {
            for arg in argumentTypes {
                if arg != nil {
                    if (
                        methodName is "Sort" or
                            "BinarySearch" or
                            "SequenceEqual" or
                            "Distinct" or
                            "DistinctBy" or
                            "Union" or
                            "UnionBy" or
                            "Intersect" or
                            "IntersectBy" or
                            "Except" or
                            "ExceptBy" or
                            "ToHashSet" or
                            "SetEquals" or
                            "Overlaps" or
                            "IsSubsetOf" or
                            "IsProperSubsetOf" or
                            "IsSupersetOf" or
                            "IsProperSupersetOf" or
                            "UnionWith" or
                            "IntersectWith" or
                            "ExceptWith" or
                            "SymmetricExceptWith" or
                            "Min" or
                            "Max" or
                            "MinBy" or
                            "MaxBy" or
                            "Order" or
                            "OrderDescending" or
                            "OrderBy" or
                            "OrderByDescending" or
                            "ThenBy" or
                            "ThenByDescending"
                    ) &&
                        GetElementOrIndexerTypeOf(arg) is {} elem {
                        AddComparedTypeWithTupleElements(comparedTypes, elem)
                    } else {
                        AddComparedTypeWithTupleElements(comparedTypes, arg)
                    }
                } else {
                    comparedTypes.Add(nil)
                }
            }
        }
        for ct in comparedTypes {
            let s = StripAllNullability(ct) ?? ct
            if s is ImportedTypeSymbol imp &&
                imp.ClrType is {} clr &&
                !IsModeledFrameworkType(clr, clr.FullName ?? "") {
                summary.WritesAnyStorage = true
                return
            }
        }
        var kinds = comparerKinds
        if receiverType?.ClrType is {} comparerOwner {
            kinds |= StoredComparerKinds(comparerOwner)
        }
        if declFullName == "System.Linq.Enumerable" && argumentTypes == nil {
            kinds |= 3
        }
        if kinds != 0 && !defaultComparer {
            summary.WritesAnyStorage = true
            return
        }
        let hasUnknownType = comparedTypes.Count == 0 || comparedTypes.Any((t TypeSymbol?) -> t == nil)
        if !defaultComparer && (hasUnknownType || comparedTypes.Count > 0) {
            MergeCreatedComparerCallbackEffects(comparedTypes, hasUnknownType, visiting, summary)
            if summary.WritesAnyStorage {
                return
            }
        }
        let index = GetCompilationMethodsByName()
        let names = if isOrdered {
            []string{"Equals", "GetHashCode", "CompareTo", "Compare"}
        } else {
            []string{"Equals", "GetHashCode"}
        }
        for name in names {
            if index.TryGetValue(name, out var methods) {
                for m in methods {
                    if m.IsStatic || (m.Declaration == nil && m.LocalDeclaration == nil) || visiting.Contains(m) {
                        continue
                    }
                    var matches = false
                    if name == "Equals" && m.Parameters.Length == 1 && object.Equals(m.Type, TypeSymbol.Bool) {
                        matches = hasUnknownType || comparedTypes.Any(
                            (ct TypeSymbol?) -> CallbackOwnerMayMatchValueType(m.ReceiverType, ct)
                        )
                    } else if name == "GetHashCode" && m.Parameters.Length == 0 && object.Equals(
                        m.Type,
                        TypeSymbol.Int32
                    ) {
                        matches = hasUnknownType || comparedTypes.Any(
                            (ct TypeSymbol?) -> CallbackOwnerMayMatchValueType(m.ReceiverType, ct)
                        )
                    } else if name == "CompareTo" && m.Parameters.Length == 1 && object.Equals(
                        m.Type,
                        TypeSymbol.Int32
                    ) {
                        matches = hasUnknownType || comparedTypes.Any(
                            (ct TypeSymbol?) -> CallbackOwnerMayMatchValueType(m.ReceiverType, ct)
                        )
                    } else if name == "Equals" && m.Parameters.Length == 2 && object.Equals(m.Type, TypeSymbol.Bool) {
                        let p0 = StripAllNullability(m.Parameters[0].Type) ?? m.Parameters[0].Type
                        matches = hasUnknownType || object.Equals(p0, TypeSymbol.Object) || comparedTypes.Any(
                            (ct TypeSymbol?) -> WrittenLocationMayHoldRoot(p0, ct, isElement: false)
                        )
                    } else if name == "GetHashCode" && m.Parameters.Length == 1 && object.Equals(
                        m.Type,
                        TypeSymbol.Int32
                    ) {
                        let p0 = StripAllNullability(m.Parameters[0].Type) ?? m.Parameters[0].Type
                        matches = hasUnknownType || object.Equals(p0, TypeSymbol.Object) || comparedTypes.Any(
                            (ct TypeSymbol?) -> WrittenLocationMayHoldRoot(p0, ct, isElement: false)
                        )
                    } else if name == "Compare" && m.Parameters.Length == 2 && object.Equals(m.Type, TypeSymbol.Int32) {
                        let p0 = StripAllNullability(m.Parameters[0].Type) ?? m.Parameters[0].Type
                        matches = hasUnknownType || object.Equals(p0, TypeSymbol.Object) || comparedTypes.Any(
                            (ct TypeSymbol?) -> WrittenLocationMayHoldRoot(p0, ct, isElement: false)
                        )
                    }
                    if !matches {
                        continue
                    }
                    let s = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out _)
                    summary.MergeFrom(s)
                    if summary.WritesAnyStorage {
                        break
                    }
                }
            }
            if summary.WritesAnyStorage {
                break
            }
        }
    }

    private func MergeFormatProviderCallbackEffects(
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        checkUnmodeledExternal bool = false
    ) {
        if checkUnmodeledExternal && HasUnmodeledImportedComparer() {
            summary.WritesAnyStorage = true
            return
        }
        let formatProviderType = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(IFormatProvider),
            NullabilityFreeReason.ResolvedTypeName
        )
        let customFormatterType = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(ICustomFormatter),
            NullabilityFreeReason.ResolvedTypeName
        )
        let index = GetCompilationMethodsByName()
        let names = []string{"GetFormat", "Format"}
        for name in names {
            if index.TryGetValue(name, out var methods) {
                for m in methods {
                    if m.IsStatic || (m.Declaration == nil && m.LocalDeclaration == nil) || visiting.Contains(m) {
                        continue
                    }
                    if name == "GetFormat" &&
                        m
                        .Parameters
                        .Length == 1 &&
                        m.ReceiverType != nil &&
                        Conversion
                        .IsRepresentationPreservingImplicit(m.ReceiverType, formatProviderType) {
                        let s = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out _)
                        summary.MergeFrom(s)
                        if summary.WritesAnyStorage {
                            return
                        }
                    } else if name == "Format" &&
                        m
                        .Parameters
                        .Length == 3 &&
                        m.ReceiverType != nil &&
                        Conversion
                        .IsRepresentationPreservingImplicit(m.ReceiverType, customFormatterType) {
                        let s = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out _)
                        summary.MergeFrom(s)
                        if summary.WritesAnyStorage {
                            return
                        }
                    }
                }
            }
        }
    }

    private func MergeToStringCallbackEffects(
        methodName string,
        receiverType TypeSymbol?,
        argumentTypes List[TypeSymbol?]?,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary
    ) {
        MergeFormatProviderCallbackEffects(
            visiting,
            summary,
            checkUnmodeledExternal: methodName is "Create" or "Format" or "AppendFormat"
        )
        if summary.WritesAnyStorage {
            return
        }
        let formattedTypes = List[TypeSymbol?]()
        if methodName is "ToString" or "TryFormat" {
            if receiverType != nil {
                AddComparedTypeWithTupleElements(formattedTypes, receiverType)
            } else if argumentTypes != nil && argumentTypes.Count > 0 {
                AddComparedTypeWithTupleElements(formattedTypes, argumentTypes[0])
            }
        } else if argumentTypes != nil {
            for arg in argumentTypes {
                AddComparedTypeWithTupleElements(formattedTypes, arg)
                if arg != nil &&
                    (methodName is "Join" or "AppendJoin" or "Concat" or "Format" or "AppendFormat") &&
                    GetElementOrIndexerTypeOf(arg) is {} elem {
                    AddComparedTypeWithTupleElements(formattedTypes, elem)
                }
            }
        }
        for ft in formattedTypes {
            let s = StripAllNullability(ft) ?? ft
            if s == nil || object.Equals(s, TypeSymbol.Object) ||
                s is InterfaceSymbol or
                TypeParameterSymbol ||
                (
                s is StructSymbol source &&
                    source.IsClass &&
                    (source.IsOpen || source.IsAbstract || source.IsSealedHierarchy)
            ) ||
                (
                s is ImportedTypeSymbol imp &&
                    imp.ClrType is {} clr &&
                    (
                    !IsModeledFrameworkType(clr, clr.FullName ?? "") ||
                        clr.IsInterface ||
                        (!clr.IsSealed && !clr.IsValueType)
                )
            ) {
                summary.WritesAnyStorage = true
                return
            }
        }
        let hasUnknownType = formattedTypes.Count == 0 || formattedTypes.Any((t TypeSymbol?) -> t == nil)
        if !hasUnknownType && !formattedTypes.Any(
            (ft TypeSymbol?) -> {
                let s = StripAllNullability(ft) ?? ft
                return s == nil || object.Equals(s, TypeSymbol.Object) ||
                    s is StructSymbol or
                    InterfaceSymbol or
                    TypeParameterSymbol ||
                    (
                    s is ImportedTypeSymbol imp &&
                        imp.ClrType is {} clr &&
                        (clr.IsInterface || (!clr.IsSealed && !clr.IsValueType))
                )
            }
        ) {
            return
        }
        let index = GetCompilationMethodsByName()
        let names = []string{"ToString", "TryFormat"}
        for name in names {
            if index.TryGetValue(name, out var methods) {
                for m in methods {
                    if m.IsStatic || (m.Declaration == nil && m.LocalDeclaration == nil) || visiting.Contains(m) {
                        continue
                    }
                    if (
                        name == "ToString" &&
                            (
                            !object.Equals(StripAllNullability(m.Type) ?? m.Type, TypeSymbol.String) ||
                                m
                                .Parameters
                                .Length > 2
                        )
                    ) ||
                        (name == "TryFormat" && !object.Equals(m.Type, TypeSymbol.Bool)) {
                        continue
                    }
                    if !hasUnknownType && !formattedTypes.Any(
                        (ft TypeSymbol?) -> CallbackOwnerMayMatchValueType(m.ReceiverType, ft)
                    ) {
                        continue
                    }
                    let s = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out _)
                    summary.MergeFrom(s)
                    if summary.WritesAnyStorage {
                        break
                    }
                }
            }
            if summary.WritesAnyStorage {
                break
            }
        }
    }

    private var activeTraversalDirectMemo Dictionary[FunctionSymbol, CallEffectSummary]? = nil
    private var activeTraversalOverridesMemo Dictionary[FunctionSymbol, CallEffectSummary]? = nil
    private var activeRootVisitingFunction FunctionSymbol? = nil

    private func GetFunctionEffectSummaryCore(
        function FunctionSymbol,
        includeOverrides bool,
        visiting HashSet[FunctionSymbol],
        out hitCycle bool
    ) CallEffectSummary {
        let orig = function
        let services = binderCtx.Services
        if includeOverrides {
            if services.CachedCallEffectSummariesWithOverrides != nil &&
                services.CachedCallEffectSummariesWithOverrides!!.TryGetValue(orig, out var cachedWithOverrides) {
                hitCycle = false
                return cachedWithOverrides
            }
            if activeTraversalOverridesMemo != nil && activeTraversalOverridesMemo!!.TryGetValue(
                orig,
                out var memoWithOverrides
            ) {
                hitCycle = true
                return memoWithOverrides
            }
        } else {
            if services.CachedCallEffectSummaries != nil && services.CachedCallEffectSummaries!!.TryGetValue(
                orig,
                out var cachedDirect
            ) {
                hitCycle = false
                return cachedDirect
            }
            if activeTraversalDirectMemo != nil && activeTraversalDirectMemo!!.TryGetValue(orig, out var memoDirect) {
                hitCycle = true
                return memoDirect
            }
        }
        let isTopLevelRoot = visiting.Count == 0
        if isTopLevelRoot {
            activeTraversalDirectMemo = Dictionary[FunctionSymbol, CallEffectSummary](
                ReferenceEqualityComparer.Instance
            )
            activeTraversalOverridesMemo = Dictionary[FunctionSymbol, CallEffectSummary](
                ReferenceEqualityComparer.Instance
            )
            activeRootVisitingFunction = orig
        }
        if !visiting.Add(orig) {
            hitCycle = true
            let recursive = CallEffectSummary()
            recursive.InvokesCallbackParameter = FunctionHasCallbackParameter(orig)
            return recursive
        }
        var localCycle = false
        var directSummary CallEffectSummary
        if services.CachedCallEffectSummaries != nil && services.CachedCallEffectSummaries!!.TryGetValue(
            orig,
            out var existingDirect
        ) {
            directSummary = existingDirect
        } else if activeTraversalDirectMemo != nil && activeTraversalDirectMemo!!.TryGetValue(
            orig,
            out var existingMemoDirect
        ) {
            directSummary = existingMemoDirect
            localCycle = true
        } else {
            directSummary = ComputeDirectFunctionEffectSummary(orig, visiting, out localCycle)
            if activeTraversalDirectMemo != nil {
                activeTraversalDirectMemo!![orig] = directSummary
            }
            if !localCycle || visiting.Count == 1 {
                if services.CachedCallEffectSummaries == nil {
                    services.CachedCallEffectSummaries = Dictionary[FunctionSymbol, CallEffectSummary](
                        ReferenceEqualityComparer.Instance
                    )
                }
                services.CachedCallEffectSummaries!![orig] = directSummary
            }
        }
        if !includeOverrides {
            visiting.Remove(orig)
            if isTopLevelRoot {
                activeTraversalDirectMemo = nil
                activeTraversalOverridesMemo = nil
                activeRootVisitingFunction = nil
            }
            hitCycle = localCycle
            return directSummary
        }
        let combined = CallEffectSummary()
        combined.MergeFrom(directSummary)
        if orig.ReceiverType is InterfaceSymbol{Accessibility: Accessibility.Public} {
            combined.WritesAnyStorage = true
        }
        if !combined.WritesAnyStorage {
            let index = GetCompilationMethodsByName()
            if index.TryGetValue(orig.Name, out var candidates) {
                for candidate in candidates {
                    if object.ReferenceEquals(candidate, orig) {
                        continue
                    }
                    if CandidateMayOverrideOrImplement(candidate, orig) {
                        let candSummary = GetFunctionEffectSummaryCore(
                            candidate,
                            includeOverrides: false,
                            visiting,
                            out var candCycle
                        )
                        if candCycle {
                            localCycle = true
                        }
                        combined.MergeFrom(candSummary)
                        if combined.WritesAnyStorage {
                            break
                        }
                    }
                }
            }
        }
        visiting.Remove(orig)
        if activeTraversalOverridesMemo != nil {
            activeTraversalOverridesMemo!![orig] = combined
        }
        if !localCycle || visiting.Count == 0 {
            if services.CachedCallEffectSummariesWithOverrides == nil {
                services.CachedCallEffectSummariesWithOverrides = Dictionary[FunctionSymbol, CallEffectSummary](
                    ReferenceEqualityComparer.Instance
                )
            }
            services.CachedCallEffectSummariesWithOverrides!![orig] = combined
        }
        if isTopLevelRoot {
            activeTraversalDirectMemo = nil
            activeTraversalOverridesMemo = nil
            activeRootVisitingFunction = nil
        }
        hitCycle = localCycle
        return combined
    }

    private func CandidateMayOverrideOrImplement(candidate FunctionSymbol, target FunctionSymbol) bool {
        if candidate.IsStatic != target.IsStatic || candidate.Parameters.Length != target.Parameters.Length {
            return false
        }
        let candOwner = candidate.ReceiverType ?? candidate.StaticOwnerType
        let targetOwner = target.ReceiverType ?? target.StaticOwnerType
        if targetOwner is InterfaceSymbol targetIface {
            let targetDef = targetIface.Definition ?? targetIface
            if candOwner is StructSymbol candStruct {
                for level in candStruct.GetHierarchy() {
                    for implIface in level.Interfaces {
                        for baseIface in implIface.SelfAndAllBaseInterfaces() {
                            if object.ReferenceEquals(baseIface.Definition ?? baseIface, targetDef) {
                                return true
                            }
                        }
                    }
                }
                return false
            }
            if candOwner is InterfaceSymbol candIface {
                for baseIface in candIface.SelfAndAllBaseInterfaces() {
                    if object.ReferenceEquals(baseIface.Definition ?? baseIface, targetDef) {
                        return true
                    }
                }
                return false
            }
            return false
        }
        if targetOwner is StructSymbol targetStruct {
            let targetDef = targetStruct.Definition ?? targetStruct
            if candOwner is StructSymbol candStruct {
                for level in candStruct.GetHierarchy() {
                    if object.ReferenceEquals(level.Definition ?? level, targetDef) {
                        return true
                    }
                }
            }
        }
        return false
    }

    private func CandidateMayOverrideOrImplementClr(
        candidate FunctionSymbol,
        clrMethod MethodInfo,
        receiverType TypeSymbol?
    ) bool {
        if candidate.IsStatic != clrMethod.IsStatic || candidate.Parameters.Length != clrMethod.GetParameters().Length {
            return false
        }
        let candOwner = candidate.ReceiverType as StructSymbol
        if candOwner == nil {
            return false
        }
        if receiverType != nil && !CallbackOwnerMayMatchValueType(candOwner, receiverType) {
            return false
        }
        let declType = clrMethod.DeclaringType
        if declType == nil {
            return true
        }
        let openDecl = if declType.IsGenericType {
            declType.GetGenericTypeDefinition()
        } else {
            declType
        }
        if openDecl.FullName == "System.Object" {
            return true
        }
        if declType.IsInterface {
            for level in candOwner.GetHierarchy() {
                for clrIface in level.ImplementedClrInterfaces {
                    if ClrTypeMatchesOrImplementsInterface(clrIface.ClrType, openDecl) {
                        return true
                    }
                }
                for srcIface in level.Interfaces {
                    for baseIface in srcIface.SelfAndAllBaseInterfaces() {
                        for clrBase in baseIface.BaseClrInterfaces {
                            if ClrTypeMatchesOrImplementsInterface(clrBase.ClrType, openDecl) {
                                return true
                            }
                        }
                    }
                }
                if level
                    .ImportedBaseType
                    ?.ClrType is {} baseClr &&
                    ClrTypeMatchesOrImplementsInterface(baseClr, openDecl) {
                    return true
                }
            }
            return false
        }
        let lastBase = candOwner.GetHierarchy().Last().ImportedBaseType?.ClrType
        return lastBase != nil && ClrTypeDerivesFromClass(lastBase, openDecl)
    }

    private func ClrTypeMatchesOrImplementsInterface(type Type?, targetOpenInterface Type) bool {
        if type == nil || ReflectionType(type) is not{} reflected {
            return false
        }
        let openType = if reflected.IsGenericType {
            reflected.GetGenericTypeDefinition()
        } else {
            reflected
        }
        if openType.FullName == targetOpenInterface.FullName {
            return true
        }
        try {
            for iface in reflected.GetInterfaces() {
                let openIface = if iface.IsGenericType {
                    iface.GetGenericTypeDefinition()
                } else {
                    iface
                }
                if openIface.FullName == targetOpenInterface.FullName {
                    return true
                }
            }
        } catch (ex NotSupportedException) {
            return true
        }
        return false
    }

    private func ClrTypeDerivesFromClass(type Type?, targetOpenClass Type) bool {
        var current = if type != nil {
            ReflectionType(type)
        } else {
            default(Type?)
        }
        while current != nil {
            let openCur = if current.IsGenericType {
                current.GetGenericTypeDefinition()
            } else {
                current
            }
            if openCur.FullName == targetOpenClass.FullName {
                return true
            }
            current = current.BaseType
        }
        return false
    }

    private func SubstituteImportedEffectElement(element TypeSymbol, arguments ImmutableArray[TypeSymbol?]) TypeSymbol {
        if element.ClrType is {IsGenericParameter: true, DeclaringMethod: not nil} parameter &&
            !arguments.IsDefaultOrEmpty &&
            parameter.GenericParameterPosition < arguments.Length &&
            arguments[parameter.GenericParameterPosition] is {} argument {
            return argument
        }
        return element
    }

    private func AnalyzeImportedMethodEffects(
        method MethodInfo,
        receiverType TypeSymbol?,
        argumentTypes List[TypeSymbol?]?,
        typeArguments ImmutableArray[TypeSymbol?],
        includeOverrides bool,
        visiting HashSet[FunctionSymbol],
        receiverIsFreshLocal bool = false,
        receiverHasDefaultComparer bool = false,
        exactEnumeration bool = false
    ) CallEffectSummary {
        let summary = CallEffectSummary()
        let declType = method.DeclaringType
        let declFullName = declType?.FullName ?? ""
        let methodName = method.Name

        // 1. Check virtual / interface overrides in the compilation (Limitation Class 3):
        if includeOverrides &&
            !method.IsStatic &&
            ((method.IsVirtual && !method.IsFinal) || declType?.IsInterface == true) {
            var canDispatchToCompilationOverride = true
            let strippedRecv = StripAllNullability(receiverType) ?? receiverType
            if strippedRecv is StructSymbol recvStruct {
                let canHaveSubclass = recvStruct.IsClass &&
                    (recvStruct.IsOpen || recvStruct.IsAbstract || recvStruct.IsSealedHierarchy)
                if !canHaveSubclass {
                    canDispatchToCompilationOverride = false
                    for level in recvStruct.GetHierarchy() {
                        for m in level.Methods {
                            if m.Name == methodName && m.Parameters.Length == method.GetParameters().Length {
                                let raw = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out _)
                                summary.MergeFrom(
                                    ApplyReceiverAndMethodSubstitution(
                                        raw,
                                        recvStruct,
                                        m,
                                        ImmutableArray[TypeSymbol].Empty
                                    )
                                )
                            }
                        }
                    }
                }
            } else if strippedRecv?.IsValueType == true ||
                strippedRecv is ArrayTypeSymbol or
                SliceTypeSymbol or
                RectangularArrayTypeSymbol ||
                object.Equals(strippedRecv, TypeSymbol.String) {
                canDispatchToCompilationOverride = false
            } else if strippedRecv?.ClrType is {} recvClr &&
                ReflectionType(recvClr) is {} reflectedRecv &&
                reflectedRecv.IsSealed &&
                !reflectedRecv.IsInterface {
                canDispatchToCompilationOverride = false
            }
            if canDispatchToCompilationOverride {
                summary.WritesAnyStorage = true
                return summary
            }
        }

        // 2. Unsafe, Marshal, Reflection, Interlocked, Delegate.DynamicInvoke, Activator (Limitation Class 7):
        if HasUnknownImportedMethodEffects(declFullName, methodName) {
            summary.WritesAnyStorage = true
            return summary
        }

        // 2b. Unmodeled external types or types with mutable static fields (Finding 4):
        if !IsModeledFrameworkType(declType, declFullName) {
            summary.WritesAnyStorage = true
            return summary
        }
        let modeledOwner = if declType is {IsGenericType: true} genericOwner {
            genericOwner.GetGenericTypeDefinition().FullName ?? declFullName
        } else {
            declFullName
        }
        if !HasFrameworkMethodEffectModel(modeledOwner, methodName, HasIntrinsicFrameworkValueLayout(declType)) {
            summary.WritesAnyStorage = true
            return summary
        }

        // 3. Mutating methods on Imported Container / Slot receivers (Limitation Class 4):
        if !receiverIsFreshLocal &&
            !method.IsStatic &&
            receiverType != nil &&
            !IsReadOnlyContainerMethodName(methodName) &&
            methodName != "CopyTo" &&
            methodName != "TryCopyTo" {
            if GetContainerSlotTypes(receiverType) is {} slotTypes {
                for slot in slotTypes {
                    if slot.IsElement {
                        summary.AddElementType(slot.SlotType)
                    } else {
                        summary.AddFieldType(slot.SlotType)
                    }
                }
            }
            if declType != nil &&
                ReflectionType(declType) is {} reflectedDecl &&
                !reflectedDecl.IsPrimitive &&
                !reflectedDecl
                .IsEnum {
                try {
                    for clrField in reflectedDecl.GetFields(
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
                    ) {
                        if !clrField.IsInitOnly &&
                            !clrField.IsLiteral &&
                            (clrField.IsPublic || clrField.IsFamily || clrField.IsFamilyOrAssembly) {
                            let fType = MemberLookup.GetClrFieldTypeSymbol(receiverType, clrField) ??
                                ClrNullability.GetFieldTypeSymbol(clrField)
                            summary.AddFieldType(fType)
                        }
                    }
                } catch (ex NotSupportedException) {
                    summary.WritesAnyStorage = true
                    return summary
                }
            }
        }

        // 4. Imported methods writing into an Array / Span / Memory / ArraySegment argument (e.g. CopyTo, Array.Clear):
        if !IsPureViewOrQueryMethodOnArrayOrSpan(declFullName, methodName) {
            let parameters = method.GetParameters()
            if argumentTypes != nil {
                let count = Math.Min(argumentTypes.Count, parameters.Length)
                for var i = 0; i < count; i++ {
                    if ClrOverloadResolution.IsParamsArrayParameter(parameters[i]) {
                        continue
                    }
                    if argumentTypes[i] is {} argType {
                        if TryGetMutableBufferElementType(argType) is {} elemType {
                            summary.AddElementType(SubstituteImportedEffectElement(elemType, typeArguments))
                        }
                    } else {
                        let projType = if receiverType != nil {
                            MemberLookup.GetClrMethodParameterTypeSymbol(receiverType, method, i)
                        } else {
                            ClrNullability.GetParameterTypeSymbol(parameters[i])
                        }
                        if TryGetMutableBufferElementType(projType) is {} elemType {
                            summary.AddElementType(SubstituteImportedEffectElement(elemType, typeArguments))
                        } else if parameters[i].ParameterType.FullName == "System.Array" {
                            summary.AddElementType(TypeSymbol.Object)
                        }
                    }
                }
            } else {
                for var i = 0; i < parameters.Length; i++ {
                    if ClrOverloadResolution.IsParamsArrayParameter(parameters[i]) {
                        continue
                    }
                    let projType = if receiverType != nil {
                        MemberLookup.GetClrMethodParameterTypeSymbol(receiverType, method, i)
                    } else {
                        ClrNullability.GetParameterTypeSymbol(parameters[i])
                    }
                    if TryGetMutableBufferElementType(projType) is {} elemType {
                        summary.AddElementType(SubstituteImportedEffectElement(elemType, typeArguments))
                    } else if parameters[i].ParameterType.FullName == "System.Array" {
                        summary.AddElementType(TypeSymbol.Object)
                    }
                }
            }
        }

        // 5. Implicit Equality / Comparer and ToString / Formatting callbacks (Limitation Class 6):
        if MayInvokeEqualityOrComparerCallback(declFullName, methodName) {
            var comparerKinds = 0
            for parameter in method.GetParameters() {
                comparerKinds |= ComparerContractKind(parameter.ParameterType)
            }
            MergeEqualityOrComparerCallbackEffects(
                declFullName,
                methodName,
                receiverType,
                argumentTypes,
                visiting,
                summary,
                comparerKinds,
                receiverHasDefaultComparer
            )
        }
        if MayInvokeToStringCallback(declFullName, methodName) {
            MergeToStringCallbackEffects(methodName, receiverType, argumentTypes, visiting, summary)
        }
        if !IsDeferredLinqOperatorName(methodName) && methodName !is "Empty" or "Range" or "Repeat" {
            let hasLazySource = IsLazyEnumerableType(receiverType) ||
                (argumentTypes != nil && argumentTypes.Any((a TypeSymbol?) -> IsLazyEnumerableType(a)))
            if hasLazySource &&
                !exactEnumeration &&
                (
                visiting.Count == 0 ||
                    CompilationHasGlobalOrStaticEnumerable() ||
                    VisitingChainAcceptsEnumerable(visiting)
            ) {
                MergeDeferredEnumerableCallbackEffects(visiting, summary)
            }
        }

        let resultType = method.ReturnType
        let resultName = (
            if resultType.IsGenericType {
                resultType.GetGenericTypeDefinition()
            } else {
                resultType
            }
        ).FullName ??
            ""
        if !IsDeferredEnumerableFactory(declFullName, resultName) {
            for p in method.GetParameters() {
                if ClrTypeUtilities.IsDelegateType(p.ParameterType) {
                    summary.InvokesCallbackParameter = true
                    break
                }
            }
        }

        return summary
    }

    private func IsModeledByRefReturningContainerType(
        declFullName string
    ) bool -> declFullName is "System.Runtime.CompilerServices.Unsafe" or
        "System.Runtime.InteropServices.CollectionsMarshal" or
        "System.Runtime.InteropServices.MemoryMarshal" or
        "System.Collections.Generic.LinkedListNode`1" or
        "System.Array" or
        "System.Span`1" or
        "System.ReadOnlySpan`1" or
        "System.Collections.Immutable.ImmutableInterlocked" or
        "System.Threading.Interlocked" or
        "System.Threading.Volatile"

    private func IsLazyEnumerableType(type TypeSymbol?) bool {
        let stripped = StripAllNullability(type) ?? type
        if stripped is SequenceTypeSymbol {
            return true
        }
        let fullName = ((stripped as ImportedTypeSymbol)?.OpenDefinition ?? stripped?.ClrType)?.FullName ?? ""
        return IsEnumerableEffectTypeName(fullName)
    }

    private func BoundArgumentsContainLazyEnumerable(arguments ImmutableArray[BoundExpression]) bool {
        for arg in arguments {
            if IsLazyEnumerableType(arg.Type) {
                return true
            }
        }
        return false
    }

    private func IsConcreteNonIteratorCollectionType(type TypeSymbol?) bool {
        let stripped = StripAllNullability(type) ?? type
        switch stripped {
            case ArrayTypeSymbol, SliceTypeSymbol, RectangularArrayTypeSymbol, MapTypeSymbol {
                return true
            }
            case imp is ImportedTypeSymbol {
                let openName = (imp.OpenDefinition ?? imp.ClrType)?.FullName ?? ""
                return openName is "System.Collections.Generic.List`1" or
                    "System.Collections.Immutable.ImmutableArray`1" or
                    "System.Collections.Generic.Dictionary`2" or
                    "System.Collections.Generic.HashSet`1" or
                    "System.Collections.Generic.Queue`1" or
                    "System.Collections.Generic.Stack`1"
            }
            default {
                return false
            }
        }
    }

    private func CompilationHasGlobalOrStaticEnumerable() bool {
        var curScope BoundScope? = $scope
        while curScope != nil {
            for v in curScope.GetDeclaredVariables() {
                if v is GlobalVariableSymbol && IsLazyEnumerableType(v.Type) {
                    return true
                }
            }
            curScope = curScope.Parent
        }
        for tree in CollectCompilationSyntaxTrees() {
            for member in tree.Root.Members {
                if member is VariableDeclarationSyntax {
                    return true
                }
            }
        }
        return false
    }

    private func VisitingChainAcceptsEnumerable(visiting HashSet[FunctionSymbol]) bool {
        if activeRootVisitingFunction is {} rootFn {
            for p in rootFn.Parameters {
                if IsLazyEnumerableType(p.Type) {
                    return true
                }
            }
        }
        return false
    }

    private func IsDeferredLinqOperatorName(mName string) bool {
        let services = binderCtx.Services
        if services.CachedDeferredLinqOperatorNames == nil {
            let names = HashSet[string](StringComparer.Ordinal)
            let callbackPositions = Dictionary[string, HashSet[int32]](StringComparer.Ordinal)
            var enumerableType = typeof(Enumerable)
            let references = $scope.References ?? binderCtx.References
            if references != nil && references.TryResolveType("System.Linq.Enumerable", out var importedEnumerable) {
                enumerableType = importedEnumerable ?? enumerableType
            }
            for method in enumerableType.GetMethods(BindingFlags.Public | BindingFlags.Static) {
                let result = method.ReturnType
                if result.IsGenericType && result.GetGenericTypeDefinition().FullName is
                "System.Collections.Generic.IEnumerable`1" or "System.Linq.IOrderedEnumerable`1" {
                    names.Add(method.Name)
                    if !callbackPositions.TryGetValue(method.Name, out var positions) {
                        positions = HashSet[int32]()
                        callbackPositions[method.Name] = positions
                    }
                    let parameters = method.GetParameters()
                    for var i = 0; i < parameters.Length; i++ {
                        if ClrTypeUtilities.IsDelegateType(parameters[i].ParameterType) {
                            positions.Add(i)
                        }
                    }
                }
            }
            services.CachedDeferredLinqCallbackPositions = callbackPositions
            services.CachedDeferredLinqOperatorNames = names
        }
        return services.CachedDeferredLinqOperatorNames!!.Contains(mName)
    }

    private func CollectCompilationSyntaxTrees() List[SyntaxTree] {
        let trees = List[SyntaxTree]()
        let seen = HashSet[SyntaxTree](ReferenceEqualityComparer.Instance)
        if binderCtx.RootScope.GetCurrentReferencingSyntaxTreeForCache() is {} curTree && seen.Add(curTree) {
            trees.Add(curTree)
        }
        if function?.Declaration?.SyntaxTree is {} fnTree && seen.Add(fnTree) {
            trees.Add(fnTree)
        }
        var curScope BoundScope? = $scope
        while curScope != nil {
            for s in curScope.GetDeclaredStructs() {
                if s.Declaration?.SyntaxTree is {} sTree && seen.Add(sTree) {
                    trees.Add(sTree)
                }
                for m in s.Methods {
                    if m.Declaration?.SyntaxTree is {} mTree && seen.Add(mTree) {
                        trees.Add(mTree)
                    }
                }
                for sm in s.StaticMethods {
                    if sm.Declaration?.SyntaxTree is {} smTree && seen.Add(smTree) {
                        trees.Add(smTree)
                    }
                }
            }
            for iface in curScope.GetDeclaredInterfaces() {
                if iface.Declaration?.SyntaxTree is {} iTree && seen.Add(iTree) {
                    trees.Add(iTree)
                }
            }
            for en in curScope.GetDeclaredEnums() {
                if en.Declaration?.SyntaxTree is {} eTree && seen.Add(eTree) {
                    trees.Add(eTree)
                }
            }
            for del in curScope.GetDeclaredDelegates() {
                if del.Declaration?.SyntaxTree is {} dTree && seen.Add(dTree) {
                    trees.Add(dTree)
                }
            }
            for fn in curScope.GetDeclaredFunctions() {
                if fn.Declaration?.SyntaxTree is {} fTree && seen.Add(fTree) {
                    trees.Add(fTree)
                }
            }
            for extFn in curScope.GetDeclaredExtensionFunctions() {
                if extFn.Declaration?.SyntaxTree is {} extTree && seen.Add(extTree) {
                    trees.Add(extTree)
                }
            }
            for v in curScope.GetDeclaredVariables() {
                if v.DeclaringSyntax?.SyntaxTree is {} vTree && seen.Add(vTree) {
                    trees.Add(vTree)
                }
            }
            for imp in curScope.GetDeclaredImports() {
                if imp.Declaration?.SyntaxTree is {} impTree && seen.Add(impTree) {
                    trees.Add(impTree)
                }
            }
            curScope = curScope.Parent
        }
        return trees
    }

    private func MergeDeferredEnumerableCallbackEffects(visiting HashSet[FunctionSymbol], summary CallEffectSummary) {
        var dummyCycle = false
        MergeIteratorCallbackEffects(visiting, summary, ref dummyCycle, includeCountGetter: true)
        if summary.WritesAnyStorage {
            return
        }
        var curScope BoundScope? = $scope
        while curScope != nil {
            for fn in curScope.GetDeclaredFunctions() {
                if IsLazyEnumerableType(fn.Type) {
                    let s = GetFunctionEffectSummaryCore(fn, includeOverrides: false, visiting, out _)
                    summary.MergeFrom(s)
                    if summary.WritesAnyStorage {
                        return
                    }
                }
            }
            for extFn in curScope.GetDeclaredExtensionFunctions() {
                if IsLazyEnumerableType(extFn.Type) {
                    let s = GetFunctionEffectSummaryCore(extFn, includeOverrides: false, visiting, out _)
                    summary.MergeFrom(s)
                    if summary.WritesAnyStorage {
                        return
                    }
                }
            }
            curScope = curScope.Parent
        }
        let emptyParams = Dictionary[string, ParameterSymbol](StringComparer.Ordinal)
        let emptyTypeParams = Dictionary[string, TypeParameterSymbol](StringComparer.Ordinal)
        let dummyFn = FunctionSymbol("<deferred_linq>", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void)
        let index = GetCompilationMethodsByName()
        let services = binderCtx.Services
        var linqCalls = services.CachedDeferredLinqCalls
        var yieldDecls = services.CachedYieldFunctionDecls
        if linqCalls == nil || yieldDecls == nil {
            let builtLinqCalls = List[CallExpressionSyntax]()
            let builtYieldDecls = List[FunctionDeclarationSyntax]()
            let scannedYieldFunctions = HashSet[SyntaxNode](ReferenceEqualityComparer.Instance)
            for tree in CollectCompilationSyntaxTrees() {
                for node in tree.Root.DescendantNodesAndSelf() {
                    if node is YieldStatementSyntax {
                        var p SyntaxNode? = node.Parent
                        while p != nil &&
                            p is not FunctionDeclarationSyntax &&
                            p is not FunctionLiteralExpressionSyntax &&
                            p is not LambdaExpressionSyntax {
                            p = p.Parent
                        }
                        if p is FunctionDeclarationSyntax yieldFnDecl &&
                            yieldFnDecl.Body != nil &&
                            scannedYieldFunctions.Add(yieldFnDecl) {
                            builtYieldDecls.Add(yieldFnDecl)
                        }
                    } else if node is CallExpressionSyntax call &&
                        IsDeferredLinqOperatorName(call.Identifier.ValueText) {
                        builtLinqCalls.Add(call)
                    }
                }
            }
            services.CachedDeferredLinqCalls = builtLinqCalls
            services.CachedYieldFunctionDecls = builtYieldDecls
            linqCalls = builtLinqCalls
            yieldDecls = builtYieldDecls
        }
        for yieldFnDecl in yieldDecls {
            if yieldFnDecl.Body is {} yieldBody {
                let localTypes = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                let refLocals = HashSet[string](StringComparer.Ordinal)
                let refExt = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                let localFns = Dictionary[string, SyntaxNode](StringComparer.Ordinal)
                let visitingLocalFns = HashSet[string](StringComparer.Ordinal)
                for yp in yieldFnDecl.Parameters {
                    if yp.Identifier is {} ypId && ypId.ValueText.Length > 0 {
                        localTypes[ypId.ValueText] = ResolveCalleeTypeClause(yp.Type, nil)
                        refLocals.Add(ypId.ValueText)
                    }
                }
                CollectCalleeFreshLocals(yieldBody, refLocals)
                ScanCalleeSyntaxNode(
                    yieldBody,
                    nil,
                    false,
                    dummyFn,
                    nil,
                    false,
                    emptyParams,
                    emptyTypeParams,
                    localTypes,
                    refLocals,
                    refExt,
                    localFns,
                    visitingLocalFns,
                    visiting,
                    summary,
                    ref dummyCycle
                )
                if summary.WritesAnyStorage {
                    return
                }
            }
        }
        for call in linqCalls {
            let mName = call.Identifier.ValueText
            if MayInvokeEqualityOrComparerCallback("System.Linq.Enumerable", mName) {
                MergeEqualityOrComparerCallbackEffects("System.Linq.Enumerable", mName, nil, nil, visiting, summary)
                if summary.WritesAnyStorage {
                    return
                }
            } else if mName !is "Where" or
                "Select" or
                "SelectMany" or
                "TakeWhile" or
                "SkipWhile" or
                "Take" or
                "Skip" or
                "TakeLast" or
                "SkipLast" or
                "Zip" or
                "Chunk" or
                "Append" or
                "Prepend" or
                "Concat" or
                "Reverse" or
                "Cast" or
                "OfType" or
                "AsEnumerable" or
                "DefaultIfEmpty" or
                "Empty" or
                "Range" or
                "Repeat" {
                summary.WritesAnyStorage = true
                return
            }
            let isStaticEnumerableCall = call.Parent is AccessorExpressionSyntax parentAcc && object.ReferenceEquals(
                parentAcc.RightPart,
                call
            ) &&
                parentAcc.LeftPart is NameExpressionSyntax leftName &&
                leftName
                .IdentifierToken
                .ValueText == "Enumerable"
            for var argIdx = 0; argIdx < call.Arguments.Count; argIdx++ {
                let arg = call.Arguments[argIdx]
                if arg is not NamedArgumentExpressionSyntax &&
                    services
                    .CachedDeferredLinqCallbackPositions
                    ?.TryGetValue(mName, out var callbackPositions) == true && !callbackPositions.Contains(
                    argIdx +
                        (
                        if isStaticEnumerableCall {
                            0
                        } else {
                            1
                        }
                    )
                ) {
                    continue
                }
                var cur = if arg is NamedArgumentExpressionSyntax namedArg {
                    namedArg.Expression
                } else {
                    arg
                }
                while cur is ParenthesizedExpressionSyntax paren {
                    cur = paren.Expression
                }
                if cur is LambdaExpressionSyntax lam && lam.Body != nil {
                    let localTypes = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                    let refLocals = HashSet[string](StringComparer.Ordinal)
                    let refExt = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                    let localFns = Dictionary[string, SyntaxNode](StringComparer.Ordinal)
                    let visitingLocalFns = HashSet[string](StringComparer.Ordinal)
                    for p in lam.Parameters {
                        if p.Identifier is {} pId && pId.ValueText.Length > 0 {
                            localTypes[pId.ValueText] = ResolveCalleeTypeClause(p.Type, nil)
                            refLocals.Add(pId.ValueText)
                        }
                    }
                    CollectCalleeFreshLocals(lam.Body, refLocals)
                    ScanCalleeSyntaxNode(
                        lam.Body,
                        nil,
                        false,
                        dummyFn,
                        nil,
                        false,
                        emptyParams,
                        emptyTypeParams,
                        localTypes,
                        refLocals,
                        refExt,
                        localFns,
                        visitingLocalFns,
                        visiting,
                        summary,
                        ref dummyCycle
                    )
                } else if cur is FunctionLiteralExpressionSyntax fl && fl.Body != nil {
                    let localTypes = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                    let refLocals = HashSet[string](StringComparer.Ordinal)
                    let refExt = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                    let localFns = Dictionary[string, SyntaxNode](StringComparer.Ordinal)
                    let visitingLocalFns = HashSet[string](StringComparer.Ordinal)
                    for p in fl.Parameters {
                        if p.Identifier is {} pId && pId.ValueText.Length > 0 {
                            localTypes[pId.ValueText] = ResolveCalleeTypeClause(p.Type, nil)
                            refLocals.Add(pId.ValueText)
                        }
                    }
                    CollectCalleeFreshLocals(fl.Body, refLocals)
                    ScanCalleeSyntaxNode(
                        fl.Body,
                        nil,
                        false,
                        dummyFn,
                        nil,
                        false,
                        emptyParams,
                        emptyTypeParams,
                        localTypes,
                        refLocals,
                        refExt,
                        localFns,
                        visitingLocalFns,
                        visiting,
                        summary,
                        ref dummyCycle
                    )
                } else if cur is NameExpressionSyntax nameArg {
                    let cbName = nameArg.IdentifierToken.ValueText
                    var matchedFn = false
                    for fn in $scope.TryLookupFunctions(cbName) {
                        matchedFn = true
                        summary.MergeFrom(GetFunctionEffectSummaryCore(fn, includeOverrides: false, visiting, out _))
                    }
                    if index.TryGetValue(cbName, out var methods) {
                        for m in methods {
                            if m.Declaration != nil || m.LocalDeclaration != nil {
                                matchedFn = true
                                summary.MergeFrom(
                                    GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out _)
                                )
                            }
                        }
                    }
                    if !matchedFn {
                        summary.WritesAnyStorage = true
                        return
                    }
                } else if cur is AccessorExpressionSyntax accArg {
                    var matchedFn = false
                    if accArg.RightPart is NameExpressionSyntax memberId {
                        let cbName = memberId.IdentifierToken.ValueText
                        if index.TryGetValue(cbName, out var methods) {
                            for m in methods {
                                if m.Declaration != nil || m.LocalDeclaration != nil {
                                    matchedFn = true
                                    summary.MergeFrom(
                                        GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out _)
                                    )
                                }
                            }
                        }
                    }
                    if !matchedFn {
                        summary.WritesAnyStorage = true
                        return
                    }
                }
                if summary.WritesAnyStorage {
                    return
                }
            }
        }
    }

    private func IsTrustedFrameworkAssembly(asm Assembly) bool {
        let cache = binderCtx.Services.CachedTrustedFrameworkAssemblies
        if cache.TryGetValue(asm, out var cached) {
            return cached
        }
        let trusted = ReferenceResolver.IsTrustedEffectAssembly(asm)
        cache[asm] = trusted
        return trusted
    }

    private func MergeCreatedComparerCallbackEffects(
        comparedTypes List[TypeSymbol?],
        hasUnknownType bool,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary
    ) {
        let services = binderCtx.Services
        var cachedCreateCalls = services.CachedComparerCreateCalls
        if cachedCreateCalls == nil {
            CompilationMeasurements.Count("narrowing.comparer-factory-indexes")
            let createCalls = List[(ElemType TypeSymbol?, Call CallExpressionSyntax)]()
            for tree in CollectCompilationSyntaxTrees() {
                for node in tree.Root.DescendantNodesAndSelf() {
                    if node is AccessorExpressionSyntax acc &&
                        acc.RightPart is CallExpressionSyntax call &&
                        call
                        .Identifier
                        .ValueText == "Create" &&
                        call
                        .Arguments
                        .Count >= 1 {
                        var leftName = ""
                        var createdElemType TypeSymbol? = nil
                        switch acc.LeftPart {
                            case n is NameExpressionSyntax {
                                leftName = n.IdentifierToken.ValueText
                            }
                            case idx is IndexExpressionSyntax {
                                leftName = (idx.Target as NameExpressionSyntax)?.IdentifierToken.ValueText ?? ""
                                if idx.Indices.Count == 1 && idx.Indices[0] is NameExpressionSyntax typeArgName {
                                    createdElemType = ResolveCalleeNamedType(
                                        typeArgName.IdentifierToken.ValueText,
                                        nil,
                                        nil
                                    )
                                }
                            }
                            case c is CallExpressionSyntax {
                                leftName = c.Identifier.ValueText
                                if c.TypeArgumentList is {Arguments: {Count: 1}} tal {
                                    createdElemType = ResolveCalleeTypeClause(tal.Arguments[0], nil)
                                }
                            }
                            default { }
                        }
                        if leftName is "EqualityComparer" or "Comparer" {
                            createCalls.Add((createdElemType, call))
                        }
                    }
                }
            }
            services.CachedComparerCreateCalls = createCalls
            cachedCreateCalls = createCalls
        }
        if cachedCreateCalls.Count == 0 {
            return
        }
        let emptyParams = Dictionary[string, ParameterSymbol](StringComparer.Ordinal)
        let emptyTypeParams = Dictionary[string, TypeParameterSymbol](StringComparer.Ordinal)
        let dummyFn = FunctionSymbol("<comparer_create>", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void)
        var dummyCycle = false
        let index = GetCompilationMethodsByName()
        for entry in cachedCreateCalls {
            let createdElemType = entry.ElemType
            let call = entry.Call
            if !hasUnknownType && createdElemType != nil && !comparedTypes.Any(
                (ct TypeSymbol?) -> WrittenLocationMayHoldRoot(createdElemType, ct, isElement: false)
            ) {
                continue
            }
            for arg in call.Arguments {
                var cur = if arg is NamedArgumentExpressionSyntax namedArg {
                    namedArg.Expression
                } else {
                    arg
                }
                while cur is ParenthesizedExpressionSyntax paren {
                    cur = paren.Expression
                }
                if cur is LambdaExpressionSyntax lam && lam.Body != nil {
                    let localTypes = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                    let refLocals = HashSet[string](StringComparer.Ordinal)
                    let refExt = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                    let localFns = Dictionary[string, SyntaxNode](StringComparer.Ordinal)
                    let visitingLocalFns = HashSet[string](StringComparer.Ordinal)
                    for p in lam.Parameters {
                        if p.Identifier is {} pId && pId.ValueText.Length > 0 {
                            localTypes[pId.ValueText] = ResolveCalleeTypeClause(p.Type, nil) ?? createdElemType
                            refLocals.Add(pId.ValueText)
                        }
                    }
                    CollectCalleeFreshLocals(lam.Body, refLocals)
                    ScanCalleeSyntaxNode(
                        lam.Body,
                        nil,
                        false,
                        dummyFn,
                        nil,
                        false,
                        emptyParams,
                        emptyTypeParams,
                        localTypes,
                        refLocals,
                        refExt,
                        localFns,
                        visitingLocalFns,
                        visiting,
                        summary,
                        ref dummyCycle
                    )
                } else if cur is FunctionLiteralExpressionSyntax fl && fl.Body != nil {
                    let localTypes = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                    let refLocals = HashSet[string](StringComparer.Ordinal)
                    let refExt = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
                    let localFns = Dictionary[string, SyntaxNode](StringComparer.Ordinal)
                    let visitingLocalFns = HashSet[string](StringComparer.Ordinal)
                    for p in fl.Parameters {
                        if p.Identifier is {} pId && pId.ValueText.Length > 0 {
                            localTypes[pId.ValueText] = ResolveCalleeTypeClause(p.Type, nil) ?? createdElemType
                            refLocals.Add(pId.ValueText)
                        }
                    }
                    CollectCalleeFreshLocals(fl.Body, refLocals)
                    ScanCalleeSyntaxNode(
                        fl.Body,
                        nil,
                        false,
                        dummyFn,
                        nil,
                        false,
                        emptyParams,
                        emptyTypeParams,
                        localTypes,
                        refLocals,
                        refExt,
                        localFns,
                        visitingLocalFns,
                        visiting,
                        summary,
                        ref dummyCycle
                    )
                } else if cur is NameExpressionSyntax nameArg {
                    let cbName = nameArg.IdentifierToken.ValueText
                    var matchedFn = false
                    for fn in $scope.TryLookupFunctions(cbName) {
                        matchedFn = true
                        summary.MergeFrom(GetFunctionEffectSummaryCore(fn, includeOverrides: false, visiting, out _))
                    }
                    if index.TryGetValue(cbName, out var methods) {
                        for m in methods {
                            if m.Declaration != nil || m.LocalDeclaration != nil {
                                matchedFn = true
                                summary.MergeFrom(
                                    GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out _)
                                )
                            }
                        }
                    }
                    if !matchedFn {
                        summary.WritesAnyStorage = true
                        return
                    }
                } else if !IsCalleeNilSyntax(cur) {
                    summary.WritesAnyStorage = true
                    return
                }
                if summary.WritesAnyStorage {
                    return
                }
            }
        }
    }

    private func HasUnmodeledImportedComparer(
        comparedTypes List[TypeSymbol?]? = nil,
        includeNonGeneric bool = true
    ) bool {
        let services = binderCtx.Services
        var targets = services.CachedImportedComparerTargets
        if targets == nil {
            targets = List[(Target Type?, NonGeneric bool)]()
            let refs = $scope.References ?? binderCtx.References
            if refs != nil {
                for asm in refs.Assemblies {
                    if IsTrustedFrameworkAssembly(asm) {
                        continue
                    }
                    try {
                        for type in asm.GetTypes() {
                            let contracts = List[Type](type.GetInterfaces())
                            if type.IsVisible || refs.CanAccessInternalMembers(type.Assembly) {
                                for method in type.GetMethods(
                                    BindingFlags.Public |
                                    BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
                                ) {
                                    contracts.Add(method.ReturnType)
                                }
                                for field in type.GetFields(
                                    BindingFlags.Public |
                                    BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
                                ) {
                                    contracts.Add(field.FieldType)
                                }
                            }
                            for contract in contracts {
                                let name = (
                                    if contract.IsGenericType {
                                        contract.GetGenericTypeDefinition()
                                    } else {
                                        contract
                                    }
                                ).FullName
                                if name is "System.Collections.IEqualityComparer" or "System.Collections.IComparer" {
                                    targets.Add((nil, true))
                                } else if name is "System.Collections.Generic.IEqualityComparer`1" or
                                    "System.Collections.Generic.IComparer`1" {
                                    targets.Add((contract.GetGenericArguments()[0], false))
                                }
                            }
                        }
                    } catch (error ReflectionTypeLoadException) {
                        targets.Add((nil, false))
                    } catch (error TypeLoadException) {
                        targets.Add((nil, false))
                    } catch (error IOException) {
                        targets.Add((nil, false))
                    } catch (error BadImageFormatException) {
                        targets.Add((nil, false))
                    } catch (error NotSupportedException) {
                        targets.Add((nil, false))
                    }
                }
            }
            services.CachedImportedComparerTargets = targets
        }
        for entry in targets {
            if entry.NonGeneric && !includeNonGeneric {
                continue
            }
            let target = entry.Target
            if target == nil || target.ContainsGenericParameters || comparedTypes == nil || comparedTypes.Any(
                (type TypeSymbol?) -> {
                    if type == nil || type is TypeParameterSymbol {
                        return true
                    }
                    let value = StripAllNullability(type) ?? type
                    let contract = TypeSymbol.FromClrTypeWithoutNullability(target, NullabilityFreeReason.TypeStructure)
                    return object.Equals(contract, value) ||
                        (
                        !contract.IsValueType && !value.IsValueType && Conversion.IsRepresentationPreservingImplicit(
                            value,
                            contract
                        )
                    )
                }
            ) {
                return true
            }
        }
        return false
    }

    private func ComparerContractKind(type Type) int32 {
        let name = (
            if type.IsGenericType {
                type.GetGenericTypeDefinition()
            } else {
                type
            }
        ).FullName
        return GetComparerContractKind(name ?? "")
    }

    private func StoredComparerKinds(owner Type) int32 {
        let cache = binderCtx.Services.CachedComparerStorage
        if cache.TryGetValue(owner, out var cached) {
            return cached
        }
        var stored = 0
        let pending = Stack[Type]()
        let seen = HashSet[Type]()
        pending.Push(owner)
        try {
            while pending.Count > 0 {
                let current = pending.Pop()
                if !seen.Add(current) {
                    continue
                }
                for field in current.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) {
                    stored |= ComparerContractKind(field.FieldType)
                    if !field
                        .FieldType
                        .IsArray &&
                        field
                        .FieldType
                        .Namespace
                        ?.StartsWith("System.Collections", StringComparison.Ordinal) == true {
                        pending.Push(field.FieldType)
                    }
                }
            }
        } catch (error TypeLoadException) {
            stored = 3
        } catch (error NotSupportedException) {
            stored = 3
        }
        cache[owner] = stored
        return stored
    }

    private func IsModeledFrameworkType(declType Type?, declFullName string) bool {
        if declType == nil {
            return false
        }
        var rootType = ReflectionType(declType) ?? declType
        while rootType.DeclaringType != nil {
            rootType = rootType.DeclaringType!!
        }
        if !IsTrustedFrameworkAssembly(rootType.Assembly) {
            return false
        }
        let fullName = rootType.FullName ?? declFullName
        if HasUnmodeledFrameworkCallbacks(fullName) {
            return false
        }
        let ns = rootType.Namespace ?? fullName
        if ns != "System" && !ns.StartsWith("System.", StringComparison.Ordinal) {
            return false
        }
        if ReflectionType(declType) is {} reflected {
            try {
                for clrField in reflected.GetFields(
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                ) {
                    if !clrField.IsInitOnly &&
                        !clrField.IsLiteral &&
                        (clrField.IsPublic || clrField.IsFamily || clrField.IsFamilyOrAssembly) {
                        return false
                    }
                }
            } catch (ex NotSupportedException) {
                return false
            }
        }
        return true
    }

    private func HasIntrinsicFrameworkValueLayout(type Type?, seen HashSet[Type]? = nil) bool {
        if type == nil {
            return false
        }
        let reflected = ReflectionType(type) ?? type
        if reflected.IsPrimitive || reflected.IsEnum || reflected.FullName == "System.String" {
            return true
        }
        if !reflected.IsValueType || reflected.ContainsGenericParameters {
            return false
        }
        let visited = seen ?? HashSet[Type]()
        if !visited.Add(reflected) {
            return true
        }
        try {
            return reflected.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).All(
                (field FieldInfo) -> HasIntrinsicFrameworkValueLayout(field.FieldType, visited) &&
                    field
                    .FieldType
                    .IsValueType
            )
        } catch (error NotSupportedException) {
            return false
        }
    }

    shared {
        internal func HasFrameworkMethodEffectModel(owner string, name string, intrinsicOwner bool) bool ->
        intrinsicOwner ||
            IsMutableGenericContainerTypeName(owner) ||
            IsMutableBufferTypeName(owner) ||
            (owner == "System.Object" && name == "ReferenceEquals") ||
            (owner is "System.Math" or "System.MathF" or "System.Text.StringBuilder") ||
            (
            (owner is "System.Enum" or "System.Delegate" or "System.MulticastDelegate") &&
                name is "GetHashCode" or
                "Equals" or
                "ToString"
        ) ||
            owner == "System.Linq.Enumerable" ||
            owner == "System.Array" ||
            (
            (
                IsMutableBufferTypeName(owner) ||
                    owner == "System.MemoryExtensions" ||
                    owner == "System.Runtime.InteropServices.MemoryMarshal" ||
                    owner == "System.Runtime.InteropServices.CollectionsMarshal"
            ) &&
                IsPureViewOrQueryMethodOnArrayOrSpan(owner, name)
        ) ||
            (owner == "System.Runtime.CompilerServices.Unsafe" && IsReadOnlyUnsafeMethod(name)) ||
            (
            (owner == "System.Console" || owner == "System.Text.StringBuilder") &&
                MayInvokeToStringCallback(owner, name)
        )

        internal func DefersImportedCallbackArguments(method MethodInfo) bool {
            if method.DeclaringType is not{} owner || owner.FullName != "System.Linq.Enumerable" {
                return false
            }
            let result = method.ReturnType
            let resultName = (
                if result.IsGenericType {
                    result.GetGenericTypeDefinition()
                } else {
                    result
                }
            ).FullName ??
                ""
            return IsDeferredEnumerableFactory(owner.FullName ?? "", resultName) &&
                ReferenceResolver.IsTrustedEffectAssembly(owner.Assembly)
        }

        internal func IsDeferredEnumerableFactory(owner string, result string) bool ->
        owner == "System.Linq.Enumerable" && IsEnumerableEffectTypeName(result)

        internal func IsMutableBufferTypeName(name string) bool -> name is "System.Span`1" or
            "System.Memory`1" or
            "System.ArraySegment`1" or
            "System.Runtime.CompilerServices.StrongBox`1"

        internal func IsEnumerableEffectTypeName(name string) bool ->
        name.StartsWith("System.Collections.Generic.IEnumerable`1", StringComparison.Ordinal) ||
            name == "System.Collections.IEnumerable" ||
            name.StartsWith("System.Linq.IOrderedEnumerable`1", StringComparison.Ordinal)

        internal func GetComparerContractKind(name string) int32 ->
        if name is "System.Collections.Generic.IEqualityComparer`1" or "System.Collections.Generic.IComparer`1" {
            1
        } else if name is "System.Collections.IEqualityComparer" or "System.Collections.IComparer" {
            2
        } else {
            0
        }

        internal func HasUnmodeledFrameworkCallbacks(fullName string) bool ->
        fullName.StartsWith("System.Lazy`", StringComparison.Ordinal) || fullName.StartsWith(
            "System.Threading.CancellationToken",
            StringComparison.Ordinal
        ) ||
            fullName.StartsWith("System.Threading.Timer", StringComparison.Ordinal) || fullName.StartsWith(
            "System.Threading.ThreadPool",
            StringComparison.Ordinal
        ) ||
            fullName.StartsWith("System.Threading.ExecutionContext", StringComparison.Ordinal) || fullName.StartsWith(
            "System.Threading.SynchronizationContext",
            StringComparison.Ordinal
        ) ||
            fullName.StartsWith("System.Threading.Tasks.Task", StringComparison.Ordinal) || fullName.StartsWith(
            "System.Timers.",
            StringComparison.Ordinal
        ) ||
            fullName.StartsWith("System.Diagnostics.Process", StringComparison.Ordinal) || fullName.StartsWith(
            "System.ComponentModel.",
            StringComparison.Ordinal
        ) ||
            fullName.StartsWith("System.Net.", StringComparison.Ordinal)

        internal func HasUnknownImportedMethodEffects(owner string, name string) bool ->
        (owner == "System.Runtime.CompilerServices.Unsafe" && !IsReadOnlyUnsafeMethod(name)) ||
            (
            owner is "System.Runtime.InteropServices.Marshal" or
                "System.Runtime.InteropServices.NativeMemory" or
                "System.Buffer"
        ) ||
            (
            (owner.StartsWith("System.Reflection.", StringComparison.Ordinal) || owner == "System.Type") &&
                (
                name.StartsWith("SetValue", StringComparison.Ordinal) ||
                    name is "Invoke" or
                    "InvokeMember" or
                    "CreateInstance"
            )
        ) ||
            (
            (owner is "System.Delegate" or "System.MulticastDelegate") &&
                (name is "DynamicInvoke" or "DynamicInvokeImpl" or "BeginInvoke")
        ) ||
            (owner == "System.Activator" && name.StartsWith("CreateInstance", StringComparison.Ordinal))

        internal func IsReadOnlyUnsafeMethod(name string) bool -> name is "IsNullRef" or
            "AreSame" or
            "SizeOf" or
            "NullRef" or
            "AsRef" or
            "Read" or
            "ReadUnaligned" or
            "Add" or
            "Subtract" or
            "AddByteOffset" or
            "SubtractByteOffset" or
            "ByteOffset" or
            "IsAddressGreaterThan" or
            "IsAddressLessThan" or
            "SkipInit" or
            "BitCast"

        internal func IsReadOnlyContainerMethodName(name string) bool -> name is "Contains" or
            "ContainsKey" or
            "ContainsValue" or
            "TryGetValue" or
            "IndexOf" or
            "LastIndexOf" or
            "IndexOfAny" or
            "LastIndexOfAny" or
            "BinarySearch" or
            "Find" or
            "FindIndex" or
            "FindLast" or
            "FindLastIndex" or
            "FindAll" or
            "Exists" or
            "TrueForAll" or
            "GetRange" or
            "Slice" or
            "AsSpan" or
            "AsMemory" or
            "ToArray" or
            "ToList" or
            "ToHashSet" or
            "ToDictionary" or
            "Peek" or
            "TryPeek" or
            "GetEnumerator" or
            "GetLength" or
            "GetLongLength" or
            "GetLowerBound" or
            "GetUpperBound" or
            "GetValue" or
            "GetOrAdd" or
            "EnsureCapacity" or
            "TrimExcess" or
            "Equals" or
            "GetHashCode" or
            "ToString" or
            "GetType" or
            "GetValueRefOrNullRef" or
            "Clone" or
            "AsReadOnly"

        internal func IsPureViewOrQueryMethodOnArrayOrSpan(declFullName string, name string) bool -> name is "AsSpan" or
            "AsMemory" or
            "CreateSpan" or
            "CreateReadOnlySpan" or
            "GetReference" or
            "GetArrayDataReference" or
            "TryGetArray" or
            "TryGetString" or
            "TryGetMemoryManager" or
            "Cast" or
            "AsBytes" or
            "IndexOf" or
            "LastIndexOf" or
            "IndexOfAny" or
            "LastIndexOfAny" or
            "BinarySearch" or
            "Contains" or
            "SequenceEqual" or
            "StartsWith" or
            "EndsWith" or
            "CommonPrefixLength" or
            "Count" or
            "LongCount" or
            "Any" or
            "All" or
            "First" or
            "FirstOrDefault" or
            "Last" or
            "LastOrDefault" or
            "Single" or
            "SingleOrDefault" or
            "ElementAt" or
            "ElementAtOrDefault" or
            "Where" or
            "Select" or
            "ToArray" or
            "ToList" or
            "ToHashSet" or
            "ToDictionary" or
            "Join" or
            "Concat" or
            "Format" or
            "GetLength" or
            "GetLongLength" or
            "GetLowerBound" or
            "GetUpperBound" or
            "GetValue" or
            "Exists" or
            "Find" or
            "FindIndex" or
            "FindLast" or
            "FindLastIndex" or
            "FindAll" or
            "TrueForAll" or
            "Clone" or
            "Empty" or
            "WriteLine" or
            "Write" or
            "MakeGenericType" or
            "Create" or
            "CreateRange" or
            "ToImmutableArray" or
            "ToImmutable" or
            "AddRange"

        internal func MayInvokeEqualityOrComparerCallback(declFullName string, name string) bool {
            if declFullName is "System.String" or
                "System.StringComparer" or
                "System.Runtime.CompilerServices.RuntimeHelpers" or
                "System.Boolean" or
                "System.Char" or
                "System.Byte" or
                "System.SByte" or
                "System.Int16" or
                "System.UInt16" or
                "System.Int32" or
                "System.UInt32" or
                "System.Int64" or
                "System.UInt64" or
                "System.IntPtr" or
                "System.UIntPtr" or
                "System.Single" or
                "System.Double" or
                "System.Decimal" or
                "System.Guid" {
                return false
            }
            if name is "Add" or "TryAdd" {
                if declFullName.StartsWith("System.Collections.Generic.List`", StringComparison.Ordinal) ||
                    declFullName.StartsWith("System.Collections.Immutable.ImmutableArray`", StringComparison.Ordinal) ||
                    declFullName.StartsWith("System.Collections.ObjectModel.Collection`", StringComparison.Ordinal) {
                    return false
                }
            }
            if declFullName.StartsWith("System.Collections.Generic.PriorityQueue`", StringComparison.Ordinal) &&
                name is "Enqueue" or
                "Dequeue" or
                "TryDequeue" or
                "EnqueueDequeue" or
                "DequeueEnqueue" or
                "EnqueueRange" {
                return true
            }
            return name is "ContainsKey" or
                "ContainsValue" or
                "TryGetValue" or
                "Contains" or
                "Remove" or
                "Add" or
                "TryAdd" or
                "IndexOf" or
                "LastIndexOf" or
                "BinarySearch" or
                "Sort" or
                "Equals" or
                "GetHashCode" or
                "Compare" or
                "CompareTo" or
                "Distinct" or
                "DistinctBy" or
                "Union" or
                "UnionBy" or
                "Intersect" or
                "IntersectBy" or
                "Except" or
                "ExceptBy" or
                "GroupBy" or
                "Join" or
                "GroupJoin" or
                "ToDictionary" or
                "ToLookup" or
                "ToHashSet" or
                "SequenceEqual" or
                "SetEquals" or
                "Overlaps" or
                "IsSubsetOf" or
                "IsProperSubsetOf" or
                "IsSupersetOf" or
                "IsProperSupersetOf" or
                "UnionWith" or
                "IntersectWith" or
                "ExceptWith" or
                "SymmetricExceptWith" or
                "Min" or
                "Max" or
                "MinBy" or
                "MaxBy" or
                "Order" or
                "OrderDescending" or
                "OrderBy" or
                "OrderByDescending" or
                "ThenBy" or
                "ThenByDescending"
        }

        internal func GetComparedContainerSlotIndex(owner string, method string, count int32) int32 ->
        if method == "ContainsValue" || owner.StartsWith(
            "System.Collections.Generic.PriorityQueue`",
            StringComparison.Ordinal
        ) {
            count - 1
        } else {
            0
        }

        internal func MayInvokeToStringCallback(declFullName string, name string) bool -> (
            declFullName == "System.String" && name == "Create"
        ) ||
            name is "ToString" or
            "Append" or
            "AppendLine" or
            "AppendFormat" or
            "AppendJoin" or
            "Insert" or
            "Format" or
            "Concat" or
            "Join" or
            "Write" or
            "WriteLine" or
            "TryFormat"

        internal func IsMutableGenericContainerTypeName(openName string) bool ->
        openName is "System.Collections.Generic.List`1" or
            "System.Collections.Generic.IList`1" or
            "System.Collections.Generic.ICollection`1" or
            "System.Collections.ObjectModel.Collection`1" or
            "System.Collections.Generic.Queue`1" or
            "System.Collections.Generic.Stack`1" or
            "System.Collections.Generic.LinkedList`1" or
            "System.Collections.Generic.LinkedListNode`1" or
            "System.Collections.Generic.Dictionary`2" or
            "System.Collections.Generic.IDictionary`2" or
            "System.Collections.Generic.SortedDictionary`2" or
            "System.Collections.Generic.SortedList`2" or
            "System.Collections.Generic.PriorityQueue`2" or
            "System.Span`1" or
            "System.Memory`1" or
            "System.ArraySegment`1" or
            "System.Runtime.CompilerServices.StrongBox`1"
    }

    private func TryGetMutableBufferElementType(type TypeSymbol?) TypeSymbol? {
        let stripped = StripAllNullability(type) ?? type
        switch stripped {
            case nil {
                return nil
            }
            case arr is ArrayTypeSymbol {
                return arr.ElementType
            }
            case slice is SliceTypeSymbol {
                return slice.ElementType
            }
            case rect is RectangularArrayTypeSymbol {
                return rect.ElementType
            }
            case imp is ImportedTypeSymbol {
                let openName = (imp.OpenDefinition ?? imp.ClrType)?.FullName ?? ""
                if IsMutableBufferTypeName(openName) {
                    if !imp.TypeArguments.IsDefaultOrEmpty {
                        return imp.TypeArguments[0]
                    }
                    if imp.ClrType is {IsGenericType: true} closedClr {
                        let args = closedClr.GetGenericArguments()
                        if args.Length > 0 {
                            return TypeSymbol.FromClrTypeWithoutNullability(
                                args[0],
                                NullabilityFreeReason.ResolvedTypeName
                            )
                        }
                    }
                }
                return nil
            }
            default {
                if stripped?.ClrType is {} clrArr && clrArr.IsArray && clrArr.GetElementType() is {} elemClr {
                    return TypeSymbol.FromClrTypeWithoutNullability(elemClr, NullabilityFreeReason.ResolvedTypeName)
                }
                return nil
            }
        }
    }

    private func GetContainerSlotTypes(receiverType TypeSymbol?) List[(SlotType TypeSymbol, IsElement bool)]? {
        let stripped = StripAllNullability(receiverType) ?? receiverType
        let containerClr = (stripped as ImportedTypeSymbol)?.OpenDefinition ?? stripped?.ClrType
        if stripped is {} typedContainer && containerClr is {IsGenericType: true} genericContainer {
            let name = genericContainer.GetGenericTypeDefinition().FullName ?? ""
            if IsMutableGenericContainerTypeName(name) {
                let fieldSlot = name is "System.Runtime.CompilerServices.StrongBox`1" or
                    "System.Collections.Generic.LinkedListNode`1"
                let positions = typedContainer.GetElementPositions()
                if !positions.IsDefaultOrEmpty {
                    let slots = List[(SlotType TypeSymbol, IsElement bool)]()
                    for type in positions {
                        slots.Add((type, !fieldSlot))
                    }
                    return slots
                }
            }
        }
        switch stripped {
            case nil {
                return nil
            }
            case arr is ArrayTypeSymbol {
                return List[(SlotType TypeSymbol, IsElement bool)]{(arr.ElementType, true)}
            }
            case slice is SliceTypeSymbol {
                return List[(SlotType TypeSymbol, IsElement bool)]{(slice.ElementType, true)}
            }
            case rect is RectangularArrayTypeSymbol {
                return List[(SlotType TypeSymbol, IsElement bool)]{(rect.ElementType, true)}
            }
            case mapType is MapTypeSymbol {
                return List[(SlotType TypeSymbol, IsElement bool)]{(mapType.KeyType, true), (mapType.ValueType, true)}
            }
            case s is StructSymbol {
                if s.GetHierarchy().Last().ImportedBaseType is {} impBase {
                    return GetContainerSlotTypes(impBase)
                }
                return nil
            }
            case iface is InterfaceSymbol {
                for clrBase in iface.BaseClrInterfaces {
                    if GetContainerSlotTypes(clrBase) is {} slots {
                        return slots
                    }
                }
                return nil
            }
            case imp is ImportedTypeSymbol {
                let openName = (imp.OpenDefinition ?? imp.ClrType)?.FullName ?? ""
                if IsMutableGenericContainerTypeName(openName) {
                    let isFieldSlot = openName.StartsWith(
                        "System.Runtime.CompilerServices.StrongBox`",
                        StringComparison.Ordinal
                    ) ||
                        openName.StartsWith("System.Collections.Generic.LinkedListNode`", StringComparison.Ordinal)
                    let list = List[(SlotType TypeSymbol, IsElement bool)]()
                    if !imp.TypeArguments.IsDefaultOrEmpty {
                        for arg in imp.TypeArguments {
                            list.Add((arg, !isFieldSlot))
                        }
                        return list
                    }
                    if imp.ClrType is {IsGenericType: true} closedClr {
                        for argClr in closedClr.GetGenericArguments() {
                            list.Add(
                                (
                                    TypeSymbol.FromClrTypeWithoutNullability(
                                        argClr,
                                        NullabilityFreeReason.ResolvedTypeName
                                    ),
                                    !isFieldSlot
                                )
                            )
                        }
                        return list
                    }
                }
            }
            default { }
        }
        if stripped?.ClrType is {} clr {
            if clr.FullName == "System.Text.StringBuilder" {
                return List[(SlotType TypeSymbol, IsElement bool)]{(TypeSymbol.Char, true)}
            }
            if clr.IsArray {
                if clr.GetElementType() is {} elemClr {
                    return List[(SlotType TypeSymbol, IsElement bool)]{
                        (
                            TypeSymbol.FromClrTypeWithoutNullability(elemClr, NullabilityFreeReason.ResolvedTypeName),
                            true
                        )
                    }
                }
                return List[(SlotType TypeSymbol, IsElement bool)]{(TypeSymbol.Object, true)}
            }
            if clr.FullName is "System.Array" or
                "System.Collections.IList" or
                "System.Collections.IDictionary" or
                "System.Collections.ArrayList" or
                "System.Collections.Hashtable" or
                "System.Collections.Queue" or
                "System.Collections.Stack" {
                return List[(SlotType TypeSymbol, IsElement bool)]{(TypeSymbol.Object, true)}
            }
            if clr.IsGenericType {
                let openName = clr.GetGenericTypeDefinition().FullName ?? ""
                if IsMutableGenericContainerTypeName(openName) {
                    let isFieldSlot = openName.StartsWith(
                        "System.Runtime.CompilerServices.StrongBox`",
                        StringComparison.Ordinal
                    ) ||
                        openName.StartsWith("System.Collections.Generic.LinkedListNode`", StringComparison.Ordinal)
                    let list = List[(SlotType TypeSymbol, IsElement bool)]()
                    for argClr in clr.GetGenericArguments() {
                        list.Add(
                            (
                                TypeSymbol.FromClrTypeWithoutNullability(
                                    argClr,
                                    NullabilityFreeReason.ResolvedTypeName
                                ),
                                !isFieldSlot
                            )
                        )
                    }
                    return list
                }
            }
        }
        return nil
    }

    private func ApplyReceiverAndMethodSubstitution(
        sourceSummary CallEffectSummary,
        receiverType TypeSymbol?,
        callee FunctionSymbol?,
        methodTypeArgs ImmutableArray[TypeSymbol],
        argumentTypes List[TypeSymbol?]? = nil
    ) CallEffectSummary {
        let substituted = CallEffectSummary()
        if sourceSummary.WritesAnyStorage {
            substituted.WritesAnyStorage = true
            return substituted
        }
        let inferred = Dictionary[TypeParameterSymbol, TypeSymbol]()
        if methodTypeArgs.IsDefaultOrEmpty && callee != nil && argumentTypes != nil {
            for var i = 0; i < Math.Min(callee.Parameters.Length, argumentTypes.Count); i++ {
                if argumentTypes[i] is {} argumentType {
                    Binder.InferTypeArguments(callee.Parameters[i].Type, argumentType, inferred)
                }
            }
        }
        substituted.InvokesCallbackParameter = sourceSummary.InvokesCallbackParameter
        if sourceSummary.IsEmpty {
            return substituted
        }
        for ft in sourceSummary.WrittenFieldTypes {
            let written = SubstituteWrittenType(ft, receiverType, callee, methodTypeArgs)
            substituted.AddFieldType(StructSymbol.SubstituteTypeParameters(written, inferred) ?? written)
        }
        for et in sourceSummary.WrittenElementTypes {
            let written = SubstituteWrittenType(et, receiverType, callee, methodTypeArgs)
            substituted.AddElementType(StructSymbol.SubstituteTypeParameters(written, inferred) ?? written)
        }
        return substituted
    }

    private func SubstituteWrittenType(
        type TypeSymbol,
        receiverType TypeSymbol?,
        callee FunctionSymbol?,
        methodTypeArgs ImmutableArray[TypeSymbol]
    ) TypeSymbol {
        var result = type
        if !TypeSymbol.ContainsTypeParameter(result) {
            return result
        }
        if receiverType != nil {
            let strippedRecv = StripAllNullability(receiverType) ?? receiverType
            if strippedRecv is StructSymbol recvStruct {
                for level in recvStruct.GetHierarchy() {
                    if !level.TypeArguments.IsDefaultOrEmpty {
                        result = level.SubstituteMemberType(result) ?? result
                    }
                    for implIface in level.Interfaces {
                        for baseIface in implIface.SelfAndAllBaseInterfaces() {
                            if !baseIface.TypeArguments.IsDefaultOrEmpty {
                                result = baseIface.SubstituteMemberType(result)
                            }
                        }
                    }
                }
            } else if strippedRecv is InterfaceSymbol recvIface {
                for level in recvIface.SelfAndAllBaseInterfaces() {
                    if !level.TypeArguments.IsDefaultOrEmpty {
                        result = level.SubstituteMemberType(result)
                    }
                }
            }
        }
        if callee != nil && !callee.TypeParameters.IsDefaultOrEmpty && !methodTypeArgs.IsDefaultOrEmpty {
            let origCallee = callee
            let count = Math.Min(origCallee.TypeParameters.Length, methodTypeArgs.Length)
            if count > 0 {
                let subst = Dictionary[TypeParameterSymbol, TypeSymbol]()
                for var i = 0; i < count; i++ {
                    if methodTypeArgs[i] != nil {
                        subst[origCallee.TypeParameters[i]] = methodTypeArgs[i]
                    }
                }
                result = StructSymbol.SubstituteTypeParameters(result, subst) ?? result
            }
        }
        return result
    }

    private func SummaryMayOverwriteRoot(summary CallEffectSummary, rootType TypeSymbol) bool {
        if summary.WritesAnyStorage || summary.InvokesCallbackParameter {
            return true
        }
        if summary.IsEmpty {
            return false
        }
        for fieldType in summary.WrittenFieldTypes {
            if WrittenLocationMayHoldRoot(fieldType, rootType, isElement: false) {
                return true
            }
        }
        for elementType in summary.WrittenElementTypes {
            if WrittenLocationMayHoldRoot(elementType, rootType, isElement: true) {
                return true
            }
        }
        return false
    }

    private func WrittenLocationMayHoldRoot(
        writtenType TypeSymbol?,
        rootType TypeSymbol?,
        isElement bool,
        visitedStructs HashSet[StructSymbol]? = nil,
        visitedClrStructs HashSet[Type]? = nil
    ) bool {
        if writtenType == nil || rootType == nil {
            return true
        }
        let loc = StripAllNullability(writtenType) ?? writtenType
        let root = StripAllNullability(rootType) ?? rootType
        if loc is ByRefTypeSymbol byRefLoc {
            return WrittenLocationMayHoldRoot(byRefLoc.PointeeType, root, isElement, visitedStructs, visitedClrStructs)
        }
        if root is ByRefTypeSymbol byRefRoot {
            return WrittenLocationMayHoldRoot(loc, byRefRoot.PointeeType, isElement, visitedStructs, visitedClrStructs)
        }
        if loc == TypeSymbol.Error || root == TypeSymbol.Error {
            return true
        }
        if object.Equals(loc, root) {
            return true
        }
        if loc.ClrType?.IsGenericParameter == true || root.ClrType?.IsGenericParameter == true {
            return true
        }
        if loc is TypeParameterSymbol locTp {
            return TypeParameterMayHoldRoot(locTp, root, isElement, visitedStructs)
        }
        if root is TypeParameterSymbol rootTp {
            return TypeParameterMayHoldRoot(rootTp, loc, isElement, visitedStructs)
        }
        if Conversion.IsRepresentationPreservingImplicit(root, loc) || Conversion.IsRepresentationPreservingImplicit(
            loc,
            root
        ) {
            return true
        }
        if loc is InterfaceSymbol || root is InterfaceSymbol {
            if ByReferenceTypesMayOverlap(loc, root) {
                return true
            }
        }
        if TypeSymbol.ContainsTypeParameter(loc) || TypeSymbol.ContainsTypeParameter(root) {
            if loc is ArrayTypeSymbol arrA && root is ArrayTypeSymbol arrB {
                return WrittenLocationMayHoldRoot(
                    arrA.ElementType,
                    arrB.ElementType,
                    true,
                    visitedStructs,
                    visitedClrStructs
                )
            }
            if loc is SliceTypeSymbol sliceA && root is SliceTypeSymbol sliceB {
                return WrittenLocationMayHoldRoot(
                    sliceA.ElementType,
                    sliceB.ElementType,
                    true,
                    visitedStructs,
                    visitedClrStructs
                )
            }
            if loc is StructSymbol sA && root is StructSymbol sB && object.ReferenceEquals(
                sA.Definition ?? sA,
                sB.Definition ?? sB
            ) &&
                sA
                .TypeArguments
                .Length == sB
                .TypeArguments
                .Length {
                for var i = 0; i < sA.TypeArguments.Length; i++ {
                    if !WrittenLocationMayHoldRoot(
                        sA.TypeArguments[i],
                        sB.TypeArguments[i],
                        isElement,
                        visitedStructs,
                        visitedClrStructs
                    ) {
                        return false
                    }
                }
                return true
            }
            if loc is ImportedTypeSymbol impA &&
                root is ImportedTypeSymbol impB &&
                impA.OpenDefinition != nil &&
                impA.OpenDefinition == impB.OpenDefinition &&
                impA
                .TypeArguments
                .Length == impB
                .TypeArguments
                .Length {
                for var i = 0; i < impA.TypeArguments.Length; i++ {
                    if !WrittenLocationMayHoldRoot(
                        impA.TypeArguments[i],
                        impB.TypeArguments[i],
                        isElement,
                        visitedStructs,
                        visitedClrStructs
                    ) {
                        return false
                    }
                }
                return true
            }
        }
        if loc is StructSymbol{IsClass: false} valStruct {
            let seen = visitedStructs ?? HashSet[StructSymbol](ReferenceEqualityComparer.Instance)
            let def = valStruct.Definition ?? valStruct
            if seen.Add(def) {
                for field in valStruct.Fields {
                    if !field.IsStatic {
                        let fieldType = valStruct.SubstituteMemberType(field.Type) ?? field.Type
                        if WrittenLocationMayHoldRoot(fieldType, root, isElement, seen, visitedClrStructs) {
                            return true
                        }
                    }
                }
                for prop in valStruct.Properties {
                    if !prop.IsStatic && !prop.IsIndexer && prop.GetterSymbol == nil && prop.SetterSymbol == nil {
                        let propType = valStruct.SubstituteMemberType(prop.Type) ?? prop.Type
                        if WrittenLocationMayHoldRoot(propType, root, isElement, seen, visitedClrStructs) {
                            return true
                        }
                    }
                }
            }
        }
        if loc is TupleTypeSymbol tuple {
            for elem in tuple.ElementTypes {
                if WrittenLocationMayHoldRoot(elem, root, isElement, visitedStructs, visitedClrStructs) {
                    return true
                }
            }
        }
        if loc is ImportedTypeSymbol impVal && impVal.ClrType?.IsValueType == true {
            if !impVal.TypeArguments.IsDefaultOrEmpty {
                for arg in impVal.TypeArguments {
                    if WrittenLocationMayHoldRoot(arg, root, isElement, visitedStructs, visitedClrStructs) {
                        return true
                    }
                }
            }
            let valClr = impVal.OpenDefinition ?? impVal.ClrType
            if valClr != nil &&
                !valClr.IsPrimitive &&
                !valClr.IsEnum &&
                valClr.FullName != "System.Decimal" &&
                valClr.FullName != "System.IntPtr" &&
                valClr.FullName != "System.UIntPtr" {
                if ReflectionType(valClr) is not{} reflectedVal {
                    return true
                }
                let seenClr = visitedClrStructs ?? HashSet[Type](ReferenceEqualityComparer.Instance)
                if seenClr.Add(reflectedVal) {
                    try {
                        for clrField in reflectedVal.GetFields(
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
                        ) {
                            if object.ReferenceEquals(clrField.FieldType, reflectedVal) {
                                continue
                            }
                            let fType = MemberLookup.GetClrFieldTypeSymbol(impVal, clrField) ??
                                ClrNullability.GetFieldTypeSymbol(clrField)
                            if WrittenLocationMayHoldRoot(fType, root, isElement, visitedStructs, seenClr) {
                                return true
                            }
                        }
                    } catch (ex NotSupportedException) {
                        return true
                    }
                }
            }
        }
        return false
    }

    private func TypeParameterMayHoldRoot(
        tp TypeParameterSymbol,
        other TypeSymbol,
        isElement bool,
        visitedStructs HashSet[StructSymbol]?
    ) bool {
        if CanInstantiateTypeParameterWith(tp, other) {
            return true
        }
        // An open value argument can be an imported aggregate whose fields include the guarded storage.
        if !tp.HasReferenceTypeConstraint && tp.ClassConstraint == nil && !other.IsValueType {
            return true
        }
        for s in binderCtx.RootScope.GetDeclaredStructs() {
            if !s.IsClass && CanInstantiateTypeParameterWith(tp, s) {
                if WrittenLocationMayHoldRoot(s, other, isElement, visitedStructs) {
                    return true
                }
            }
        }
        return false
    }

    private func CanInstantiateTypeParameterWith(tp TypeParameterSymbol, candidate TypeSymbol) bool {
        if candidate is TypeParameterSymbol {
            return true
        }
        if tp.HasValueTypeConstraint && !candidate.IsValueType {
            return false
        }
        if tp.HasReferenceTypeConstraint && candidate.IsValueType {
            return false
        }
        if tp.HasDefaultConstructorConstraint && !candidate.IsValueType {
            if object.Equals(candidate, TypeSymbol.String) {
                return false
            }
            if candidate is StructSymbol s && s.IsClass && !s.IsOpen && !s.IsAbstract && !s.IsSealedHierarchy {
                if !s.ExplicitConstructors.IsDefaultOrEmpty && !s.ExplicitConstructors.Any(
                    (c ConstructorSymbol) -> c.Parameters.IsEmpty
                ) {
                    return false
                }
            }
        }
        if tp.ClassConstraint is {} classBound {
            if !Conversion.IsRepresentationPreservingImplicit(candidate, classBound) &&
                !Conversion.IsRepresentationPreservingImplicit(classBound, candidate) {
                return false
            }
        }
        return true
    }

    private func IsInterpolatedStringHandlerStruct(s StructSymbol) bool {
        let orig = s.Definition ?? s
        for m in orig.Methods {
            if m.Name is "AppendLiteral" or "AppendFormatted" {
                return true
            }
        }
        return false
    }

    private func MergeInterpolatedStringHandlerStructEffects(
        handlerStruct StructSymbol,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        let origHandler = handlerStruct.Definition ?? handlerStruct
        var initCycle = false
        ScanStructInstanceInitializers(origHandler, visiting, summary, ref initCycle)
        if initCycle {
            hitCycle = true
        }
        for ctor in origHandler.EffectiveExplicitConstructors {
            if !ctor.IsSynthesizedFromPrimaryConstructor && ctor.Declaration != nil {
                let ctorSummary = GetFunctionEffectSummaryCore(
                    ctor.Function,
                    includeOverrides: false,
                    visiting,
                    out var c
                )
                if c {
                    hitCycle = true
                }
                summary.MergeFrom(
                    ApplyReceiverAndMethodSubstitution(
                        ctorSummary,
                        handlerStruct,
                        ctor.Function,
                        ImmutableArray[TypeSymbol].Empty
                    )
                )
            }
        }
        for m in origHandler.Methods {
            if m.Name is "AppendLiteral" or "AppendFormatted" {
                let mSummary = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out var c)
                if c {
                    hitCycle = true
                }
                summary.MergeFrom(
                    ApplyReceiverAndMethodSubstitution(mSummary, handlerStruct, m, ImmutableArray[TypeSymbol].Empty)
                )
            }
        }
    }

    private func ComputeDirectFunctionEffectSummary(
        orig FunctionSymbol,
        visiting HashSet[FunctionSymbol],
        out hitCycle bool
    ) CallEffectSummary {
        hitCycle = false
        let summary = CallEffectSummary()
        for p in orig.Parameters {
            let strippedParam = StripAllNullability(p.Type) ?? p.Type
            if strippedParam is StructSymbol paramStruct && IsInterpolatedStringHandlerStruct(paramStruct) {
                var handlerCycle = false
                MergeInterpolatedStringHandlerStructEffects(paramStruct, visiting, summary, ref handlerCycle)
                if handlerCycle {
                    hitCycle = true
                }
                if summary.WritesAnyStorage {
                    return summary
                }
            }
        }
        var body BlockStatementSyntax? = orig
            .Declaration
            ?.Body ??
            (orig.LocalDeclaration?.Initializer as FunctionLiteralExpressionSyntax)?.Body
        if body == nil && orig.AssociatedSymbol is PropertySymbol assocProp {
            let origProp = assocProp.OriginalDefinition ?? assocProp
            if object.ReferenceEquals(assocProp.GetterSymbol, orig) || object.ReferenceEquals(
                origProp.GetterSymbol,
                orig
            ) ||
                orig.MethodKind == MethodKind
                .PropertyGet {
                if origProp.IsAutoProperty {
                    return summary
                }
                body = origProp.GetterBodySyntax ?? assocProp.GetterBodySyntax
            } else if object.ReferenceEquals(assocProp.SetterSymbol, orig) || object.ReferenceEquals(
                origProp.SetterSymbol,
                orig
            ) ||
                orig.MethodKind == MethodKind
                .PropertySet {
                if (orig.ReceiverType ?? orig.StaticOwnerType) is not StructSymbol propOwner ||
                    CanPropertyBeAliasedByRef(propOwner, origProp) {
                    summary.AddFieldType(origProp.Type)
                }
                if origProp.IsAutoProperty {
                    return summary
                }
                body = origProp.SetterBodySyntax ?? assocProp.SetterBodySyntax
            }
        }
        let maybeCtorOwner = (orig.ReceiverType ?? orig.Type) as StructSymbol
        let isNamedCtor = maybeCtorOwner != nil &&
            (
            orig.Name == "init" ||
                orig.Name == ".ctor" ||
                orig.Name == (maybeCtorOwner.Definition ?? maybeCtorOwner).Name
        )
        if isNamedCtor && maybeCtorOwner != nil {
            var initCycle = false
            ScanStructInstanceInitializers(maybeCtorOwner, visiting, summary, ref initCycle)
            if initCycle {
                hitCycle = true
            }
            if summary.WritesAnyStorage {
                return summary
            }
        }
        if body == nil && isNamedCtor && maybeCtorOwner != nil {
            let origOwner = maybeCtorOwner.Definition ?? maybeCtorOwner
            if origOwner.EffectiveExplicitConstructors.IsDefaultOrEmpty {
                return summary
            }
            for ctor in origOwner.EffectiveExplicitConstructors {
                if object.ReferenceEquals(ctor.Function, orig) ||
                    ctor
                    .Function
                    .Parameters
                    .Length == orig
                    .Parameters
                    .Length {
                    if ctor.IsSynthesizedFromPrimaryConstructor || ctor.Declaration == nil {
                        return summary
                    }
                    body = ctor.Declaration?.Body
                    break
                }
            }
            if body == nil {
                return summary
            }
        }
        if body == nil {
            if orig.IsAbstract || orig.ReceiverType is InterfaceSymbol {
                return summary
            }
            if orig.Declaration == nil && orig.LocalDeclaration == nil {
                if orig.Name == "Deconstruct" {
                    if orig.ReceiverType is StructSymbol owner {
                        for prop in owner.Properties {
                            if !prop.IsStatic && prop.GetterSymbol is {} getter {
                                let getterSummary = GetFunctionEffectSummaryCore(
                                    getter,
                                    includeOverrides: true,
                                    visiting,
                                    out var c
                                )
                                if c {
                                    hitCycle = true
                                }
                                summary.MergeFrom(getterSummary)
                            }
                        }
                    }
                    return summary
                }
                if orig.Name is "Equals" or "GetHashCode" or "CompareTo" or "Compare" {
                    if orig.ReceiverType is StructSymbol owner {
                        let fieldTypes = List[TypeSymbol?]()
                        for f in owner.Fields {
                            if !f.IsStatic {
                                fieldTypes.Add(f.Type)
                            }
                        }
                        for prop in owner.Properties {
                            if !prop.IsStatic {
                                fieldTypes.Add(prop.Type)
                                if prop.GetterSymbol is {} getter {
                                    let getterSummary = GetFunctionEffectSummaryCore(
                                        getter,
                                        includeOverrides: true,
                                        visiting,
                                        out var c
                                    )
                                    if c {
                                        hitCycle = true
                                    }
                                    summary.MergeFrom(getterSummary)
                                }
                            }
                        }
                        if fieldTypes.Count > 0 {
                            MergeEqualityOrComparerCallbackEffects("", orig.Name, nil, fieldTypes, visiting, summary)
                        }
                    }
                    return summary
                }
                if orig.Name is "ToString" or "PrintMembers" {
                    if orig.ReceiverType is StructSymbol owner {
                        let fieldTypes = List[TypeSymbol?]()
                        for f in owner.Fields {
                            if !f.IsStatic {
                                fieldTypes.Add(f.Type)
                            }
                        }
                        for prop in owner.Properties {
                            if !prop.IsStatic {
                                fieldTypes.Add(prop.Type)
                                if prop.GetterSymbol is {} getter {
                                    let getterSummary = GetFunctionEffectSummaryCore(
                                        getter,
                                        includeOverrides: true,
                                        visiting,
                                        out var c
                                    )
                                    if c {
                                        hitCycle = true
                                    }
                                    summary.MergeFrom(getterSummary)
                                }
                            }
                        }
                        if fieldTypes.Count > 0 {
                            MergeToStringCallbackEffects("Append", nil, fieldTypes, visiting, summary)
                        }
                    }
                    return summary
                }
            }
            summary.WritesAnyStorage = true
            return summary
        }

        let enclosingType = orig.ReceiverType ??
            orig.StaticOwnerType ??
            orig.LexicalEnclosingType ??
            (
            if isNamedCtor {
                cast[TypeSymbol?](maybeCtorOwner)
            } else {
                default(TypeSymbol?)
            }
        )
        let isConstructor = isNamedCtor
        let parameters = Dictionary[string, ParameterSymbol](StringComparer.Ordinal)
        for p in orig.Parameters {
            parameters[p.Name] = p
        }
        if orig.ExplicitReceiverParameter is {} explicitThis {
            parameters[explicitThis.Name] = explicitThis
        }
        let calleeTypeParams = Dictionary[string, TypeParameterSymbol](StringComparer.Ordinal)
        if enclosingType is StructSymbol encStruct {
            for tp in encStruct.TypeParameters {
                calleeTypeParams[tp.Name] = tp
            }
        } else if enclosingType is InterfaceSymbol encIface {
            for tp in encIface.TypeParameters {
                calleeTypeParams[tp.Name] = tp
            }
        }
        for tp in orig.TypeParameters {
            calleeTypeParams[tp.Name] = tp
        }
        let localTypes = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
        let refLocalsFromParams = HashSet[string](StringComparer.Ordinal)
        let refLocalsExternal = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
        let localFunctions = Dictionary[string, SyntaxNode](StringComparer.Ordinal)
        let visitingLocalFunctions = HashSet[string](StringComparer.Ordinal)

        var localCycle = false
        let calleePkgName = (enclosingType as StructSymbol)?.PackageName ??
            (enclosingType as InterfaceSymbol)?.PackageName ??
            orig
            .Package
            ?.Name
        let savedPkg = $scope.SetCurrentDeclaringPackage(calleePkgName)
        let savedTree = $scope.SetCurrentReferencingSyntaxTree(body.SyntaxTree)
        try {
            CollectCalleeFreshLocals(body, refLocalsFromParams)
            ScanCalleeSyntaxNode(
                body,
                nil,
                false,
                orig,
                enclosingType,
                isConstructor,
                parameters,
                calleeTypeParams,
                localTypes,
                refLocalsFromParams,
                refLocalsExternal,
                localFunctions,
                visitingLocalFunctions,
                visiting,
                summary,
                ref localCycle
            )
        } finally {
            $scope.SetCurrentReferencingSyntaxTree(savedTree)
            $scope.SetCurrentDeclaringPackage(savedPkg)
        }
        if summary.InvokesCallbackParameter && !FunctionHasCallbackParameter(orig) {
            summary.InvokesCallbackParameter = false
        }
        hitCycle = localCycle
        return summary
    }

    private func FunctionHasCallbackParameter(fn FunctionSymbol) bool {
        for p in fn.Parameters {
            let pt = StripAllNullability(p.Type) ?? p.Type
            if IsCallableMemberType(pt) || object.Equals(pt, TypeSymbol.Object) ||
                pt is InterfaceSymbol or
                TypeParameterSymbol {
                return true
            }
        }
        return false
    }

    private func ScanStructInstanceInitializers(
        s StructSymbol,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        for level in s.GetHierarchy() {
            let def = level.Definition ?? level
            if def.Declaration is not{} decl {
                continue
            }
            let emptyParams = Dictionary[string, ParameterSymbol](StringComparer.Ordinal)
            let typeParams = Dictionary[string, TypeParameterSymbol](StringComparer.Ordinal)
            for tp in def.TypeParameters {
                typeParams[tp.Name] = tp
            }
            let localTypes = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
            let refLocals = HashSet[string](StringComparer.Ordinal)
            let refExt = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
            let localFns = Dictionary[string, SyntaxNode](StringComparer.Ordinal)
            let visitingLocalFns = HashSet[string](StringComparer.Ordinal)
            let initSummary = CallEffectSummary()
            let dummyFn = def.StaticInitializerFunction ??
                FunctionSymbol("<init>", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void)
            let savedPkg = $scope.SetCurrentDeclaringPackage(def.PackageName)
            let savedTree = $scope.SetCurrentReferencingSyntaxTree(decl.SyntaxTree)
            try {
                for fieldDecl in decl.Fields {
                    if fieldDecl.Initializer != nil &&
                        fieldDecl.Initializer is not LiteralExpressionSyntax &&
                        fieldDecl.Initializer is not DefaultExpressionSyntax {
                        ScanCalleeSyntaxNode(
                            fieldDecl.Initializer,
                            nil,
                            false,
                            dummyFn,
                            def,
                            true,
                            emptyParams,
                            typeParams,
                            localTypes,
                            refLocals,
                            refExt,
                            localFns,
                            visitingLocalFns,
                            visiting,
                            initSummary,
                            ref hitCycle
                        )
                    }
                }
            } finally {
                $scope.SetCurrentReferencingSyntaxTree(savedTree)
                $scope.SetCurrentDeclaringPackage(savedPkg)
            }
            summary.MergeFrom(ApplyReceiverAndMethodSubstitution(initSummary, s, nil, ImmutableArray[TypeSymbol].Empty))
            if summary.WritesAnyStorage {
                return
            }
        }
    }

    private func ScanCalleeSyntaxNode(
        node SyntaxNode?,
        receiverExpr ExpressionSyntax?,
        receiverIsType bool,
        origCallee FunctionSymbol,
        enclosingType TypeSymbol?,
        isConstructor bool,
        parameters Dictionary[string, ParameterSymbol],
        calleeTypeParams Dictionary[string, TypeParameterSymbol],
        localTypes Dictionary[string, TypeSymbol?],
        refLocalsFromParams HashSet[string],
        refLocalsExternal Dictionary[string, TypeSymbol?],
        localFunctions Dictionary[string, SyntaxNode],
        visitingLocalFunctions HashSet[string],
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        if node == nil || summary.WritesAnyStorage {
            return
        }
        switch node {
            case ifExpr is IfExpressionSyntax {
                if TryGetNilCheckTargetName(ifExpr.Condition, out var nilTarget) &&
                    ifExpr
                    .ThenBlock
                    .Statements
                    .IsEmpty &&
                    TryGetSimpleAssignmentValueForTarget(ifExpr.ThenBlock.Expression, nilTarget, out var rhsExpr) {
                    ScanCalleeSyntaxNode(
                        ifExpr.Initializer,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    ScanCalleeSyntaxNode(
                        ifExpr.Condition,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    ScanCalleeSyntaxNode(
                        rhsExpr,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    if localTypes.TryGetValue(nilTarget, out var existingNilLocal) && existingNilLocal == nil {
                        localTypes[nilTarget] = InferCalleeExpressionType(
                            rhsExpr,
                            origCallee,
                            enclosingType,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            out _
                        )
                    }
                    ScanCalleeSyntaxNode(
                        ifExpr.ElseExpression,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    return
                }
                for child in ifExpr.GetChildren() {
                    ScanCalleeSyntaxNode(
                        child,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                return
            }
            case ifStmt is IfStatementSyntax {
                if TryGetNilCheckTargetName(ifStmt.Condition, out var stmtNilTarget) &&
                    ifStmt.ThenStatement is BlockStatementSyntax thenBlock &&
                    thenBlock
                    .Statements
                    .Length == 1 &&
                    thenBlock.Statements[0] is ExpressionStatementSyntax thenExprStmt &&
                    TryGetSimpleAssignmentValueForTarget(thenExprStmt.Expression, stmtNilTarget, out var stmtRhsExpr) {
                    ScanCalleeSyntaxNode(
                        ifStmt.Initializer,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    ScanCalleeSyntaxNode(
                        ifStmt.Condition,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    ScanCalleeSyntaxNode(
                        stmtRhsExpr,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    if localTypes.TryGetValue(stmtNilTarget, out var existingStmtNilLocal) &&
                        existingStmtNilLocal == nil {
                        localTypes[stmtNilTarget] = InferCalleeExpressionType(
                            stmtRhsExpr,
                            origCallee,
                            enclosingType,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            out _
                        )
                    }
                    ScanCalleeSyntaxNode(
                        ifStmt.ElseClause,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    return
                }
                for child in ifStmt.GetChildren() {
                    ScanCalleeSyntaxNode(
                        child,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                return
            }
            case fnDecl is FunctionDeclarationSyntax {
                for p in fnDecl.Parameters {
                    if p.Identifier is {} pId && pId.ValueText.Length > 0 {
                        localTypes[pId.ValueText] = ResolveCalleeTypeClause(p.Type, calleeTypeParams)
                        refLocalsFromParams.Add(pId.ValueText)
                    }
                }
                if fnDecl.Body is {} fnBody {
                    localFunctions[fnDecl.Identifier.ValueText] = fnBody
                }
                return
            }
            case FunctionLiteralExpressionSyntax,
            LambdaExpressionSyntax,
            AnonymousClassExpressionSyntax,
            NameOfExpressionSyntax {
                return
            }
            case varDecl is VariableDeclarationSyntax {
                if varDecl.Initializer is FunctionLiteralExpressionSyntax fnLit && fnLit.Body is {} litBody {
                    for p in fnLit.Parameters {
                        if p.Identifier is {} pId && pId.ValueText.Length > 0 {
                            localTypes[pId.ValueText] = ResolveCalleeTypeClause(p.Type, calleeTypeParams)
                            refLocalsFromParams.Add(pId.ValueText)
                        }
                    }
                    localFunctions[varDecl.Identifier.ValueText] = litBody
                    return
                }
                if varDecl.Initializer is LambdaExpressionSyntax lamInit && lamInit.Body is {} lamBody {
                    for p in lamInit.Parameters {
                        if p.Identifier is {} pId && pId.ValueText.Length > 0 {
                            localTypes[pId.ValueText] = ResolveCalleeTypeClause(p.Type, calleeTypeParams)
                            refLocalsFromParams.Add(pId.ValueText)
                        }
                    }
                    localFunctions[varDecl.Identifier.ValueText] = lamBody
                    return
                }
                ScanCalleeSyntaxNode(
                    varDecl.Initializer,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let varName = varDecl.Identifier.ValueText
                var varType = if varDecl.TypeClause != nil {
                    ResolveCalleeTypeClause(varDecl.TypeClause, calleeTypeParams)
                } else {
                    InferCalleeExpressionType(
                        varDecl.Initializer,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    )
                }
                if varType is ByRefTypeSymbol byRefVar {
                    varType = byRefVar.PointeeType
                }
                localTypes[varName] = varType
                if varDecl.HasRefKindModifier {
                    let initName = UnwrapRefTargetName(varDecl.Initializer)
                    if initName != nil && !refLocalsExternal.ContainsKey(initName) &&
                        (
                        parameters.ContainsKey(initName) || localTypes.ContainsKey(initName) ||
                            refLocalsFromParams.Contains(initName)
                    ) {
                        refLocalsFromParams.Add(varName)
                    } else {
                        refLocalsExternal[varName] = varType
                    }
                } else if UnwrapRefTargetName(varDecl.Initializer) is {} plainInitName &&
                    (
                    parameters.ContainsKey(plainInitName) || refLocalsFromParams.Contains(plainInitName) ||
                        localFunctions.ContainsKey(plainInitName)
                ) {
                    refLocalsFromParams.Add(varName)
                }
                return
            }
            case forRange is ForRangeStatementSyntax {
                ScanCalleeSyntaxNode(
                    forRange.Collection,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let collType = InferCalleeExpressionType(
                    forRange.Collection,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                if IsLazyEnumerableType(collType) &&
                    (CompilationHasGlobalOrStaticEnumerable() || VisitingChainAcceptsEnumerable(visiting)) {
                    MergeDeferredEnumerableCallbackEffects(visiting, summary)
                } else if !IsKnownEffectFreeIterable(collType) &&
                    !IsKnownEffectFreeCollectionSyntax(forRange.Collection) {
                    ScanCalleeForEachIteratorEffects(collType, calleeTypeParams, visiting, summary, ref hitCycle)
                }
                let elemType = if forRange.TypeClause != nil {
                    ResolveCalleeTypeClause(forRange.TypeClause, calleeTypeParams)
                } else {
                    GetElementOrIndexerTypeOf(collType)
                }
                if forRange.SecondIdentifier is {} secondId {
                    localTypes[forRange.FirstIdentifier.ValueText] = TypeSymbol.Int32
                    localTypes[secondId.ValueText] = elemType
                } else {
                    localTypes[forRange.FirstIdentifier.ValueText] = elemType
                }
                ScanCalleeSyntaxNode(
                    forRange.Body,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case forTuple is ForTupleRangeStatementSyntax {
                ScanCalleeSyntaxNode(
                    forTuple.Collection,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let collType = InferCalleeExpressionType(
                    forTuple.Collection,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                if IsLazyEnumerableType(collType) &&
                    (CompilationHasGlobalOrStaticEnumerable() || VisitingChainAcceptsEnumerable(visiting)) {
                    MergeDeferredEnumerableCallbackEffects(visiting, summary)
                } else if !IsKnownEffectFreeIterable(collType) &&
                    !IsKnownEffectFreeCollectionSyntax(forTuple.Collection) {
                    ScanCalleeForEachIteratorEffects(collType, calleeTypeParams, visiting, summary, ref hitCycle)
                }
                let elemType = GetElementOrIndexerTypeOf(collType)
                if elemType is TupleTypeSymbol tupleElem &&
                    tupleElem
                    .ElementTypes
                    .Length == forTuple
                    .Identifiers
                    .Count {
                    for var i = 0; i < forTuple.Identifiers.Count; i++ {
                        localTypes[forTuple.Identifiers[i].ValueText] = tupleElem.ElementTypes[i]
                    }
                } else {
                    for id in forTuple.Identifiers {
                        localTypes[id.ValueText] = nil
                    }
                }
                ScanCalleeSyntaxNode(
                    forTuple.Body,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case forEllipsis is ForEllipsisStatementSyntax {
                ScanCalleeSyntaxNode(
                    forEllipsis.LowerBound,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                ScanCalleeSyntaxNode(
                    forEllipsis.UpperBound,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                localTypes[forEllipsis.Identifier.ValueText] = InferCalleeExpressionType(
                    forEllipsis.LowerBound,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                ) ??
                    TypeSymbol.Int32
                ScanCalleeSyntaxNode(
                    forEllipsis.Body,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case AwaitForRangeStatementSyntax, AwaitUsingStatementSyntax {
                summary.WritesAnyStorage = true
                return
            }
            case usingStmt is UsingStatementSyntax {
                ScanCalleeSyntaxNode(
                    usingStmt.Declaration,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let usingVarName = usingStmt.Declaration.Identifier.ValueText
                if localTypes.TryGetValue(usingVarName, out var dispType) && dispType != nil {
                    ScanCalleeMemberCall(
                        dispType,
                        "Dispose",
                        false,
                        nil,
                        List[TypeSymbol?](),
                        calleeTypeParams,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                return
            }
            case tupleDecon is TupleDeconstructionStatementSyntax {
                ScanCalleeSyntaxNode(
                    tupleDecon.Initializer,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let initType = StripAllNullability(
                    InferCalleeExpressionType(
                        tupleDecon.Initializer,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    )
                )
                if initType is TupleTypeSymbol tupleType &&
                    tupleType
                    .ElementTypes
                    .Length == tupleDecon
                    .Identifiers
                    .Count {
                    for var i = 0; i < tupleDecon.Identifiers.Count; i++ {
                        localTypes[tupleDecon.Identifiers[i].ValueText] = tupleType.ElementTypes[i]
                    }
                } else {
                    for id in tupleDecon.Identifiers {
                        localTypes[id.ValueText] = nil
                    }
                }
                return
            }
            case isExpr is IsExpressionSyntax {
                ScanCalleeSyntaxNode(
                    isExpr.Expression,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let exprType = InferCalleeExpressionType(
                    isExpr.Expression,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                RecordCalleePatternBindings(
                    isExpr.Pattern,
                    exprType,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes
                )
                return
            }
            case swStmt is SwitchStatementSyntax {
                ScanCalleeSyntaxNode(
                    swStmt.Expression,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let discType = InferCalleeExpressionType(
                    swStmt.Expression,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                for swCase in swStmt.Cases {
                    RecordCalleePatternBindings(
                        swCase.Value,
                        discType,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes
                    )
                    ScanCalleeSyntaxNode(
                        swCase.Guard,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    ScanCalleeSyntaxNode(
                        swCase.Body,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                return
            }
            case swExpr is SwitchExpressionSyntax {
                ScanCalleeSyntaxNode(
                    swExpr.Expression,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let discType = InferCalleeExpressionType(
                    swExpr.Expression,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                for arm in swExpr.Arms {
                    RecordCalleePatternBindings(
                        arm.Value,
                        discType,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes
                    )
                    ScanCalleeSyntaxNode(
                        arm.Guard,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    ScanCalleeSyntaxNode(
                        arm.Result,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                return
            }
            case typePat is TypePatternSyntax {
                let patType = ResolveCalleeTypeClause(typePat.Type, calleeTypeParams)
                if typePat.BindingIdentifier is {} bindId && bindId.ValueText.Length > 0 {
                    localTypes[bindId.ValueText] = patType
                }
                ScanCalleeSyntaxNode(
                    typePat.PropertyPattern,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case tcPat is TypeOrConstantPatternSyntax {
                for child in tcPat.GetChildren() {
                    ScanCalleeSyntaxNode(
                        child,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                return
            }
            case varPat is VarPatternSyntax {
                if varPat.Designation is {} desig && desig.ValueText.Length > 0 {
                    localTypes[desig.ValueText] = nil
                }
                return
            }
            case binding is IfLetBindingClauseSyntax {
                ScanCalleeSyntaxNode(
                    binding.Initializer,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                var bindType = if binding.TypeClause != nil {
                    ResolveCalleeTypeClause(binding.TypeClause, calleeTypeParams)
                } else {
                    InferCalleeExpressionType(
                        binding.Initializer,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    )
                }
                bindType = StripAllNullability(bindType) ?? bindType
                localTypes[binding.Identifier.ValueText] = bindType
                return
            }
            case catchClause is CatchClauseSyntax {
                if catchClause.Identifier is {} catchId && catchId.ValueText.Length > 0 {
                    localTypes[catchId.ValueText] = if catchClause.TypeClause != nil {
                        ResolveCalleeTypeClause(catchClause.TypeClause, calleeTypeParams)
                    } else {
                        TypeSymbol.FromClrTypeWithoutNullability(
                            typeof(Exception),
                            NullabilityFreeReason.ResolvedTypeName
                        )
                    }
                }
                ScanCalleeSyntaxNode(
                    catchClause.Filter,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                ScanCalleeSyntaxNode(
                    catchClause.Body,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case assign is AssignmentExpressionSyntax {
                ScanCalleeSyntaxNode(
                    assign.Expression,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let assignedName = assign.IdentifierToken.ValueText
                if localTypes.TryGetValue(assignedName, out var existingAssignedType) && existingAssignedType == nil {
                    localTypes[assignedName] = InferCalleeExpressionType(
                        assign.Expression,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    )
                }
                RecordCalleePlainNameWrite(
                    assignedName,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case fieldAssign is FieldAssignmentExpressionSyntax {
                ScanCalleeSyntaxNode(
                    fieldAssign.Value,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let recvName = fieldAssign.Receiver.ValueText
                let fieldName = fieldAssign.FieldIdentifier.ValueText
                let isFreshRecv = refLocalsFromParams.Contains("#fresh:" + recvName)
                if !isFreshRecv &&
                    isConstructor &&
                    (recvName == "this" || recvName == origCallee.ExplicitReceiverParameter?.Name) {
                    RecordConstructorSelfMemberWrite(enclosingType, fieldName, visiting, summary, ref hitCycle)
                    return
                }
                let recvType = InferCalleeNameOrType(
                    recvName,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out var isTypeRecv
                )
                RecordCalleeMemberWriteOnType(
                    recvType,
                    fieldName,
                    isTypeRecv,
                    visiting,
                    summary,
                    ref hitCycle,
                    isFreshReceiver: isFreshRecv
                )
                return
            }
            case memberFieldAssign is MemberFieldAssignmentExpressionSyntax {
                ScanCalleeSyntaxNode(
                    memberFieldAssign.Receiver,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                ScanCalleeSyntaxNode(
                    memberFieldAssign.Value,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let isFreshRecv = IsCalleeFreshLocalExpression(memberFieldAssign.Receiver, refLocalsFromParams)
                let recvType = InferCalleeExpressionType(
                    memberFieldAssign.Receiver,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out var isTypeRecv
                )
                RecordCalleeMemberWriteOnType(
                    recvType,
                    memberFieldAssign.FieldIdentifier.ValueText,
                    isTypeRecv,
                    visiting,
                    summary,
                    ref hitCycle,
                    isFreshReceiver: isFreshRecv
                )
                return
            }
            case indexAssign is IndexAssignmentExpressionSyntax {
                for idx in indexAssign.Indices {
                    ScanCalleeSyntaxNode(
                        idx,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                ScanCalleeSyntaxNode(
                    indexAssign.Value,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let isFreshTarget = refLocalsFromParams.Contains("#fresh:" + indexAssign.TargetIdentifier.ValueText)
                let targetType = InferCalleeNameOrType(
                    indexAssign.TargetIdentifier.ValueText,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                RecordCalleeElementWriteOnType(
                    targetType,
                    visiting,
                    summary,
                    ref hitCycle,
                    isFreshReceiver: isFreshTarget
                )
                return
            }
            case memberIndexAssign is MemberIndexAssignmentExpressionSyntax {
                ScanCalleeSyntaxNode(
                    memberIndexAssign.Target.Target,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                for idx in memberIndexAssign.Target.Indices {
                    ScanCalleeSyntaxNode(
                        idx,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                ScanCalleeSyntaxNode(
                    memberIndexAssign.Value,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let isFreshTarget = IsCalleeFreshLocalExpression(memberIndexAssign.Target.Target, refLocalsFromParams)
                let targetType = InferCalleeExpressionType(
                    memberIndexAssign.Target.Target,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                RecordCalleeElementWriteOnType(
                    targetType,
                    visiting,
                    summary,
                    ref hitCycle,
                    isFreshReceiver: isFreshTarget
                )
                return
            }
            case compoundIndexAssign is CompoundIndexAssignmentExpressionSyntax {
                ScanCalleeSyntaxNode(
                    compoundIndexAssign.Target.Target,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                for idx in compoundIndexAssign.Target.Indices {
                    ScanCalleeSyntaxNode(
                        idx,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                ScanCalleeSyntaxNode(
                    compoundIndexAssign.Value,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let isFreshTarget = IsCalleeFreshLocalExpression(compoundIndexAssign.Target.Target, refLocalsFromParams)
                let targetType = InferCalleeExpressionType(
                    compoundIndexAssign.Target.Target,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                RecordCalleeElementWriteOnType(
                    targetType,
                    visiting,
                    summary,
                    ref hitCycle,
                    isFreshReceiver: isFreshTarget,
                    isCompound: true
                )
                return
            }
            case compound is EventSubscriptionExpressionSyntax {
                ScanCalleeSyntaxNode(
                    compound.Value,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                RecordCalleeExpressionTargetWrite(
                    compound.LeftHandSide,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case coalescing is NullCoalescingAssignmentExpressionSyntax {
                ScanCalleeSyntaxNode(
                    coalescing.Target,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                ScanCalleeSyntaxNode(
                    coalescing.Value,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                if coalescing.Target is NameExpressionSyntax coalTargetName {
                    let coalName = coalTargetName.IdentifierToken.ValueText
                    if localTypes.TryGetValue(coalName, out var existingCoalType) && existingCoalType == nil {
                        localTypes[coalName] = InferCalleeExpressionType(
                            coalescing.Value,
                            origCallee,
                            enclosingType,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            out _
                        )
                    }
                }
                return
            }
            case multi is MultiAssignmentStatementSyntax {
                for val in multi.Values {
                    ScanCalleeSyntaxNode(
                        val,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                for target in multi.Targets {
                    if target is MultiAssignmentDeclarationExpressionSyntax decl {
                        localTypes[decl.Identifier.ValueText] = nil
                    } else {
                        RecordCalleeExpressionTargetWrite(
                            target,
                            origCallee,
                            enclosingType,
                            isConstructor,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            refLocalsFromParams,
                            refLocalsExternal,
                            localFunctions,
                            visitingLocalFunctions,
                            visiting,
                            summary,
                            ref hitCycle
                        )
                    }
                }
                return
            }
            case IndirectAssignmentExpressionSyntax, IndirectCompoundAssignmentExpressionSyntax {
                summary.WritesAnyStorage = true
                return
            }
            case refArg is RefArgumentExpressionSyntax {
                if refArg.IsInlineDeclaration {
                    if refArg.DeclarationIdentifier is {} declId && declId.ValueText.Length > 0 {
                        localTypes[declId.ValueText] = if refArg.DeclaredType != nil {
                            ResolveCalleeTypeClause(refArg.DeclaredType, calleeTypeParams)
                        } else {
                            default(TypeSymbol?)
                        }
                    }
                    return
                }
                ScanCalleeSyntaxNode(
                    refArg.Expression,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                if refArg.RefKindModifier.Text != "in" && refArg.Expression is {} refExpr {
                    RecordCalleeExpressionTargetWrite(
                        refExpr,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                return
            }
            case condRef is ConditionalRefArgumentExpressionSyntax {
                ScanCalleeSyntaxNode(
                    condRef.Condition,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                if condRef.WhenTrueRefKindModifier?.Text != "in" {
                    RecordCalleeExpressionTargetWrite(
                        condRef.WhenTrue,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                if condRef.WhenFalseRefKindModifier?.Text != "in" {
                    RecordCalleeExpressionTargetWrite(
                        condRef.WhenFalse,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                return
            }
            case unary is UnaryExpressionSyntax {
                if unary.OperatorToken.Kind == SyntaxKind.AmpersandToken {
                    ScanCalleeSyntaxNode(
                        unary.Operand,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    RecordCalleeExpressionTargetWrite(
                        unary.Operand,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    return
                }
                if unary.OperatorToken.Kind == SyntaxKind.BangBangToken {
                    ScanCalleeSyntaxNode(
                        unary.Operand,
                        receiverExpr,
                        receiverIsType,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    return
                }
                ScanCalleeSyntaxNode(
                    unary.Operand,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let uKind = unary.OperatorToken.Kind
                if OperatorNames.TryGetUnaryName(uKind) is {} uOpName {
                    let opType = InferCalleeExpressionType(
                        unary.Operand,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    )
                    let sOp = StripAllNullability(opType) ?? opType
                    if sOp != nil && (object.Equals(sOp, TypeSymbol.String) || TypeSymbol.IsLegalPointeeType(sOp)) {
                        for extFn in $scope.TryLookupExtensionFunctions(sOp, uOpName) {
                            let raw = GetFunctionEffectSummaryCore(extFn, includeOverrides: false, visiting, out var c)
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(raw)
                        }
                        return
                    }
                    if sOp is StructSymbol opStruct {
                        for sm in opStruct.StaticMethods {
                            if sm.Name == uOpName {
                                let raw = GetFunctionEffectSummaryCore(sm, includeOverrides: false, visiting, out var c)
                                if c {
                                    hitCycle = true
                                }
                                summary.MergeFrom(raw)
                            }
                        }
                    }
                    if sOp != nil {
                        for extFn in $scope.TryLookupExtensionFunctions(sOp, uOpName) {
                            let raw = GetFunctionEffectSummaryCore(extFn, includeOverrides: false, visiting, out var c)
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(raw)
                        }
                    }
                    if sOp is ImportedTypeSymbol impOp &&
                        impOp.ClrType is {} opClr &&
                        !IsModeledFrameworkType(opClr, opClr.FullName ?? "") {
                        summary.WritesAnyStorage = true
                    }
                }
                return
            }
            case acc is AccessorExpressionSyntax {
                if acc.LeftPart is NameExpressionSyntax volRecv &&
                    volRecv
                    .IdentifierToken
                    .ValueText == "Volatile" &&
                    acc.RightPart is CallExpressionSyntax volCall &&
                    volCall
                    .Identifier
                    .ValueText == "Read" &&
                    volCall
                    .Arguments
                    .Count == 1 {
                    let arg0 = volCall.Arguments[0]
                    if arg0 is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.AmpersandToken}} volAmp {
                        ScanCalleeSyntaxNode(
                            volAmp.Operand,
                            nil,
                            false,
                            origCallee,
                            enclosingType,
                            isConstructor,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            refLocalsFromParams,
                            refLocalsExternal,
                            localFunctions,
                            visitingLocalFunctions,
                            visiting,
                            summary,
                            ref hitCycle
                        )
                        return
                    }
                }
                let effectiveLeft = CombineAccessorLeft(receiverExpr, acc)
                ScanCalleeSyntaxNode(
                    acc.LeftPart,
                    receiverExpr,
                    receiverIsType,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let _ = InferCalleeExpressionType(
                    effectiveLeft,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out var leftIsType
                )
                ScanCalleeSyntaxNode(
                    acc.RightPart,
                    effectiveLeft,
                    leftIsType,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case call is CallExpressionSyntax {
                for arg in call.Arguments {
                    let unwrappedArg = if arg is NamedArgumentExpressionSyntax namedArg {
                        namedArg.Expression
                    } else {
                        arg
                    }
                    ScanCalleeSyntaxNode(
                        unwrappedArg,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                if receiverExpr == nil &&
                    call.Callee == nil &&
                    call.ConversionTypeClause == nil &&
                    (
                    (
                        call
                            .Identifier
                            .ValueText == "cast" &&
                            call
                            .TypeArgumentList
                            ?.Arguments
                            .Count == 1 &&
                            call
                            .Arguments
                            .Count == 1
                    ) ||
                        (
                        (call.Identifier.ValueText == "checked" || call.Identifier.ValueText == "unchecked") &&
                            call
                            .Arguments
                            .Count == 1
                    )
                ) {
                    return
                }
                if call.ConversionTypeClause != nil {
                    return
                }
                let argTypes = List[TypeSymbol?](call.Arguments.Count)
                for arg in call.Arguments {
                    let unwrappedArg = if arg is NamedArgumentExpressionSyntax namedArg {
                        namedArg.Expression
                    } else {
                        arg
                    }
                    argTypes.Add(
                        InferCalleeExpressionType(
                            unwrappedArg,
                            origCallee,
                            enclosingType,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            out _
                        )
                    )
                }
                if receiverExpr == nil {
                    var fnName = call.Identifier.ValueText
                    if call.Callee != nil {
                        var unwrappedCallee ExpressionSyntax? = call.Callee
                        while unwrappedCallee is ParenthesizedExpressionSyntax parenCallee {
                            unwrappedCallee = parenCallee.Expression
                        }
                        while unwrappedCallee is UnaryExpressionSyntax{
                            OperatorToken: {Kind: SyntaxKind.BangBangToken}
                        } bangCallee {
                            unwrappedCallee = bangCallee.Operand
                            while unwrappedCallee is ParenthesizedExpressionSyntax parenCallee2 {
                                unwrappedCallee = parenCallee2.Expression
                            }
                        }
                        if unwrappedCallee is NameExpressionSyntax calleeNameExpr {
                            fnName = calleeNameExpr.IdentifierToken.ValueText
                        } else {
                            summary.WritesAnyStorage = true
                            return
                        }
                    }
                    if localFunctions.TryGetValue(fnName, out var localBody) {
                        if visitingLocalFunctions.Add(fnName) {
                            let localCallSummary = CallEffectSummary()
                            ScanCalleeSyntaxNode(
                                localBody,
                                nil,
                                false,
                                origCallee,
                                enclosingType,
                                false,
                                parameters,
                                calleeTypeParams,
                                localTypes,
                                refLocalsFromParams,
                                refLocalsExternal,
                                localFunctions,
                                visitingLocalFunctions,
                                visiting,
                                localCallSummary,
                                ref hitCycle
                            )
                            visitingLocalFunctions.Remove(fnName)
                            ResolveCalleeSyntaxCallbackEffects(
                                localCallSummary,
                                call.Arguments,
                                nil,
                                origCallee,
                                enclosingType,
                                parameters,
                                calleeTypeParams,
                                localTypes,
                                refLocalsFromParams,
                                refLocalsExternal,
                                localFunctions,
                                visitingLocalFunctions,
                                visiting,
                                summary,
                                ref hitCycle
                            )
                        }
                        return
                    }
                    if parameters.ContainsKey(fnName) || refLocalsFromParams.Contains(fnName) {
                        summary.InvokesCallbackParameter = true
                        return
                    }
                    if enclosingType is StructSymbol encCallableOwner &&
                        IsCallableFieldOfStruct(encCallableOwner, fnName) {
                        if TryGetUnmodifiedCallableFieldBody(encCallableOwner, fnName, out var privFieldBody) &&
                            privFieldBody != nil {
                            ScanCalleeSyntaxNode(
                                privFieldBody,
                                nil,
                                false,
                                origCallee,
                                enclosingType,
                                false,
                                parameters,
                                calleeTypeParams,
                                localTypes,
                                refLocalsFromParams,
                                refLocalsExternal,
                                localFunctions,
                                visitingLocalFunctions,
                                visiting,
                                summary,
                                ref hitCycle
                            )
                        } else {
                            summary.WritesAnyStorage = true
                        }
                        return
                    }
                    if localTypes.ContainsKey(fnName) {
                        summary.WritesAnyStorage = true
                        return
                    }
                    UpdateInlineOutVarArgumentTypes(
                        call,
                        nil,
                        nil,
                        fnName,
                        enclosingType,
                        localTypes,
                        refLocalsFromParams
                    )
                    let namedCallSummary = CallEffectSummary()
                    ScanCalleeNamedCall(
                        fnName,
                        call.TypeArgumentList,
                        argTypes,
                        origCallee,
                        enclosingType,
                        calleeTypeParams,
                        visiting,
                        namedCallSummary,
                        ref hitCycle
                    )
                    ResolveCalleeSyntaxCallbackEffects(
                        namedCallSummary,
                        call.Arguments,
                        nil,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                    return
                }
                let memberName = call.Identifier.ValueText
                if InvokesDelegate(memberName) {
                    summary.WritesAnyStorage = true
                    return
                }
                if receiverExpr is NameExpressionSyntax arrRecv &&
                    arrRecv
                    .IdentifierToken
                    .ValueText == "Array" &&
                    (memberName is "Reverse" or "Clear" or "Fill") &&
                    call
                    .Arguments
                    .Count >= 1 &&
                    IsCalleeFreshLocalExpression(call.Arguments[0], refLocalsFromParams) {
                    return
                }
                let recvType = InferCalleeExpressionType(
                    receiverExpr,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out var isTypeRecv
                )
                if recvType == nil {
                    ScanCalleeUnresolvedMemberCall(memberName, argTypes, visiting, summary, ref hitCycle)
                    return
                }
                UpdateInlineOutVarArgumentTypes(
                    call,
                    receiverExpr,
                    recvType,
                    memberName,
                    enclosingType,
                    localTypes,
                    refLocalsFromParams
                )
                if (MemberShape(recvType, memberName) & MemberIsValue) != 0 {
                    summary.WritesAnyStorage = true
                    return
                }
                let recvIsFresh = IsCalleeFreshLocalExpression(receiverExpr, refLocalsFromParams)
                let memberCallSummary = CallEffectSummary()
                ScanCalleeMemberCall(
                    recvType,
                    memberName,
                    isTypeRecv,
                    call.TypeArgumentList,
                    argTypes,
                    calleeTypeParams,
                    visiting,
                    memberCallSummary,
                    ref hitCycle,
                    allowUnresolvedFallback: true,
                    receiverIsFreshLocal: recvIsFresh,
                    receiverHasDefaultComparer: IsDefaultCallbackConstructionSyntax(receiverExpr) ||
                        (
                        receiverExpr is NameExpressionSyntax name && refLocalsFromParams.Contains(
                            "#default:" + name.IdentifierToken.ValueText
                        )
                    ),
                    exactEnumeration: argTypes.All((type TypeSymbol?) -> HasClosedFrameworkEnumerationModel(type)) &&
                        call
                        .Arguments
                        .All((argument ExpressionSyntax) -> IsCalleeFreshLocalExpression(argument, refLocalsFromParams))
                )
                ResolveCalleeSyntaxCallbackEffects(
                    memberCallSummary,
                    call.Arguments,
                    GetElementOrIndexerTypeOf(recvType),
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case baseIface is BaseInterfaceCallExpressionSyntax {
                for arg in baseIface.Arguments {
                    ScanCalleeSyntaxNode(
                        arg,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                let baseIfaceSummary = CallEffectSummary()
                let ifaceType = ResolveCalleeTypeClause(baseIface.InterfaceTypeClause, calleeTypeParams)
                if ifaceType is InterfaceSymbol iface {
                    let mName = baseIface.MethodIdentifier.ValueText
                    for level in iface.SelfAndAllBaseInterfaces() {
                        level.EnsureMembersResolved()
                        for m in level.GetMethods(mName) {
                            let raw = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out var c)
                            if c {
                                hitCycle = true
                            }
                            baseIfaceSummary.MergeFrom(
                                ApplyReceiverAndMethodSubstitution(raw, iface, m, ImmutableArray[TypeSymbol].Empty)
                            )
                        }
                    }
                } else {
                    baseIfaceSummary.WritesAnyStorage = true
                }
                ResolveCalleeSyntaxCallbackEffects(
                    baseIfaceSummary,
                    baseIface.Arguments,
                    nil,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case baseClass is BaseClassCallExpressionSyntax {
                for arg in baseClass.Call.Arguments {
                    ScanCalleeSyntaxNode(
                        arg,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                let baseClassSummary = CallEffectSummary()
                let mName = baseClass.Call.Identifier.ValueText
                if enclosingType is StructSymbol encStruct {
                    let hierarchy = encStruct.GetHierarchy()
                    var matched = false
                    for var i = 1; i < hierarchy.Count; i++ {
                        let baseLevel = hierarchy[i]
                        for m in baseLevel.Methods {
                            if m.Name == mName {
                                matched = true
                                let raw = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out var c)
                                if c {
                                    hitCycle = true
                                }
                                baseClassSummary.MergeFrom(
                                    ApplyReceiverAndMethodSubstitution(
                                        raw,
                                        baseLevel,
                                        m,
                                        ImmutableArray[TypeSymbol].Empty
                                    )
                                )
                            }
                        }
                    }
                    if !matched && hierarchy.Last().ImportedBaseType is {} impBase {
                        let argTypes = List[TypeSymbol?](baseClass.Call.Arguments.Count)
                        for arg in baseClass.Call.Arguments {
                            argTypes.Add(
                                InferCalleeExpressionType(
                                    arg,
                                    origCallee,
                                    enclosingType,
                                    parameters,
                                    calleeTypeParams,
                                    localTypes,
                                    out _
                                )
                            )
                        }
                        if impBase.ClrType is {} baseClr && ReflectionType(baseClr) is {} reflected {
                            for clrMem in reflected.GetMember(
                                mName,
                                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance |
                                BindingFlags.FlattenHierarchy
                            ) {
                                if clrMem is MethodInfo clrMethod {
                                    matched = true
                                    baseClassSummary.MergeFrom(
                                        AnalyzeImportedMethodEffects(
                                            clrMethod,
                                            impBase,
                                            argTypes,
                                            default(ImmutableArray[TypeSymbol?]),
                                            includeOverrides: false,
                                            visiting
                                        )
                                    )
                                }
                            }
                        }
                    }
                    if !matched {
                        baseClassSummary.WritesAnyStorage = true
                    }
                } else {
                    baseClassSummary.WritesAnyStorage = true
                }
                ResolveCalleeSyntaxCallbackEffects(
                    baseClassSummary,
                    baseClass.Call.Arguments,
                    nil,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                return
            }
            case objCreate is ObjectCreationExpressionSyntax {
                ScanCalleeSyntaxNode(
                    objCreate.Target,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                for initSyntax in objCreate.Initializers {
                    ScanCalleeSyntaxNode(
                        initSyntax.Value,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                let createdType = InferCalleeExpressionType(
                    objCreate.Target,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                if (StripAllNullability(createdType) ?? createdType) is StructSymbol createdStruct {
                    ScanStructInstanceInitializers(createdStruct, visiting, summary, ref hitCycle)
                    for initSyntax in objCreate.Initializers {
                        let propName = initSyntax.PropertyIdentifier.ValueText
                        for level in createdStruct.GetHierarchy() {
                            for prop in level.Properties {
                                if prop.Name == propName && prop.SetterSymbol is {} setter {
                                    let setterSummary = GetFunctionEffectSummaryCore(
                                        setter,
                                        includeOverrides: false,
                                        visiting,
                                        out var c
                                    )
                                    if c {
                                        hitCycle = true
                                    }
                                    summary.MergeFrom(
                                        ApplyReceiverAndMethodSubstitution(
                                            setterSummary,
                                            createdStruct,
                                            setter,
                                            ImmutableArray[TypeSymbol].Empty
                                        )
                                    )
                                }
                            }
                        }
                    }
                }
                return
            }
            case structLit is StructLiteralExpressionSyntax {
                for elem in structLit.Elements {
                    if elem is FieldInitializerSyntax fieldInit {
                        ScanCalleeSyntaxNode(
                            fieldInit.Value,
                            nil,
                            false,
                            origCallee,
                            enclosingType,
                            isConstructor,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            refLocalsFromParams,
                            refLocalsExternal,
                            localFunctions,
                            visitingLocalFunctions,
                            visiting,
                            summary,
                            ref hitCycle
                        )
                    } else {
                        ScanCalleeSyntaxNode(
                            elem,
                            nil,
                            false,
                            origCallee,
                            enclosingType,
                            isConstructor,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            refLocalsFromParams,
                            refLocalsExternal,
                            localFunctions,
                            visitingLocalFunctions,
                            visiting,
                            summary,
                            ref hitCycle
                        )
                    }
                }
                let constructed = ResolveCalleeNamedType(
                    structLit.TypeIdentifier.ValueText,
                    structLit.TypeArgumentList,
                    calleeTypeParams
                )
                if constructed is StructSymbol s {
                    ScanStructInstanceInitializers(s, visiting, summary, ref hitCycle)
                    let origStruct = s.Definition ?? s
                    for ctor in origStruct.EffectiveExplicitConstructors {
                        if !ctor.IsSynthesizedFromPrimaryConstructor &&
                            ctor
                            .Declaration
                            ?.Body != nil &&
                            ctor
                            .Function
                            .Parameters
                            .Length == 0 {
                            let ctorSummary = GetFunctionEffectSummaryCore(
                                ctor.Function,
                                includeOverrides: false,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(
                                ApplyReceiverAndMethodSubstitution(
                                    ctorSummary,
                                    s,
                                    ctor.Function,
                                    ImmutableArray[TypeSymbol].Empty
                                )
                            )
                        }
                    }
                    for initSyntax in structLit.Initializers {
                        let propName = initSyntax.FieldIdentifier.ValueText
                        for level in s.GetHierarchy() {
                            for prop in level.Properties {
                                if prop.Name == propName && prop.SetterSymbol is {} setter {
                                    let setterSummary = GetFunctionEffectSummaryCore(
                                        setter,
                                        includeOverrides: false,
                                        visiting,
                                        out var c
                                    )
                                    if c {
                                        hitCycle = true
                                    }
                                    summary.MergeFrom(
                                        ApplyReceiverAndMethodSubstitution(
                                            setterSummary,
                                            s,
                                            setter,
                                            ImmutableArray[TypeSymbol].Empty
                                        )
                                    )
                                }
                            }
                        }
                    }
                }
                return
            }
            case nameExpr is NameExpressionSyntax {
                let name = nameExpr.IdentifierToken.ValueText
                if receiverExpr != nil {
                    let recvType = InferCalleeExpressionType(
                        receiverExpr,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out var isTypeRecv
                    )
                    RecordCalleeMemberReadEffects(recvType, name, isTypeRecv, visiting, summary, ref hitCycle)
                } else if localFunctions.TryGetValue(name, out var refLocalFnBody) {
                    if visitingLocalFunctions.Add(name) {
                        ScanCalleeSyntaxNode(
                            refLocalFnBody,
                            nil,
                            false,
                            origCallee,
                            enclosingType,
                            false,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            refLocalsFromParams,
                            refLocalsExternal,
                            localFunctions,
                            visitingLocalFunctions,
                            visiting,
                            summary,
                            ref hitCycle
                        )
                    }
                } else if !localTypes.ContainsKey(name) && !parameters.ContainsKey(name) {
                    RecordCalleeBareReadEffects(name, enclosingType, visiting, summary, ref hitCycle)
                }
                return
            }
            case interpSyntax is InterpolatedStringExpressionSyntax {
                for segment in interpSyntax.Segments {
                    if segment.IsExpression && segment.Expression is {} holeExpr {
                        ScanCalleeSyntaxNode(
                            holeExpr,
                            nil,
                            false,
                            origCallee,
                            enclosingType,
                            isConstructor,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            refLocalsFromParams,
                            refLocalsExternal,
                            localFunctions,
                            visitingLocalFunctions,
                            visiting,
                            summary,
                            ref hitCycle
                        )
                        let holeType = InferCalleeExpressionType(
                            holeExpr,
                            origCallee,
                            enclosingType,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            out _
                        )
                        if holeType == nil {
                            if holeExpr is BinaryExpressionSyntax or UnaryExpressionSyntax {
                                summary.WritesAnyStorage = true
                            } else if !IsCalleeNilSyntax(holeExpr) {
                                MergeToStringCallbackEffects("ToString", nil, nil, visiting, summary)
                            }
                        } else if !object.Equals(holeType, TypeSymbol.String) && !TypeSymbol.IsLegalPointeeType(
                            holeType
                        ) {
                            MergeToStringCallbackEffects(
                                "ToString",
                                holeType,
                                List[TypeSymbol?]{holeType},
                                visiting,
                                summary
                            )
                            if holeType is ImportedTypeSymbol impHole &&
                                impHole.ClrType is {} hClr &&
                                !IsModeledFrameworkType(hClr, hClr.FullName ?? "") {
                                summary.WritesAnyStorage = true
                            }
                        }
                    }
                }
                return
            }
            case binExpr is BinaryExpressionSyntax {
                ScanCalleeSyntaxNode(
                    binExpr.Left,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                ScanCalleeSyntaxNode(
                    binExpr.Right,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                let opKind = binExpr.OperatorToken.Kind
                if opKind is SyntaxKind.AmpersandAmpersandToken or
                    SyntaxKind.PipePipeToken or
                    SyntaxKind.QuestionQuestionToken {
                    return
                }
                if (opKind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken) &&
                    (IsCalleeNilSyntax(binExpr.Left) || IsCalleeNilSyntax(binExpr.Right)) {
                    return
                }
                let leftType = InferCalleeExpressionType(
                    binExpr.Left,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                let rightType = InferCalleeExpressionType(
                    binExpr.Right,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                let sLeft = StripAllNullability(leftType) ?? leftType
                let sRight = StripAllNullability(rightType) ?? rightType
                if opKind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken {
                    let checkLeft = sLeft ?? sRight
                    let checkRight = sRight ?? sLeft
                    if checkLeft is TupleTypeSymbol ||
                        checkRight is TupleTypeSymbol ||
                        (checkLeft is StructSymbol sl && (sl.IsData || sl.IsInline)) ||
                        (checkRight is StructSymbol sr && (sr.IsData || sr.IsInline)) {
                        let eqTypes = List[TypeSymbol?]()
                        if checkLeft != nil {
                            eqTypes.Add(checkLeft)
                        }
                        if checkRight != nil {
                            eqTypes.Add(checkRight)
                        }
                        MergeEqualityOrComparerCallbackEffects("", "Equals", checkLeft, eqTypes, visiting, summary)
                    }
                }
                if OperatorNames.TryGetBinaryName(opKind) is {} bOpName {
                    if sLeft != nil &&
                        sRight != nil &&
                        (object.Equals(sLeft, TypeSymbol.String) || TypeSymbol.IsLegalPointeeType(sLeft)) &&
                        (object.Equals(sRight, TypeSymbol.String) || TypeSymbol.IsLegalPointeeType(sRight)) {
                        for extFn in $scope.TryLookupExtensionFunctions(sLeft, bOpName) {
                            let raw = GetFunctionEffectSummaryCore(extFn, includeOverrides: false, visiting, out var c)
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(raw)
                        }
                        return
                    }
                    let opCandidates = List[TypeSymbol?]{sLeft, sRight}
                    for cand in opCandidates {
                        if cand is StructSymbol opStruct {
                            for sm in opStruct.StaticMethods {
                                if sm.Name == bOpName {
                                    let raw = GetFunctionEffectSummaryCore(
                                        sm,
                                        includeOverrides: false,
                                        visiting,
                                        out var c
                                    )
                                    if c {
                                        hitCycle = true
                                    }
                                    summary.MergeFrom(raw)
                                }
                            }
                        }
                        if cand != nil {
                            for extFn in $scope.TryLookupExtensionFunctions(cand, bOpName) {
                                let raw = GetFunctionEffectSummaryCore(
                                    extFn,
                                    includeOverrides: false,
                                    visiting,
                                    out var c
                                )
                                if c {
                                    hitCycle = true
                                }
                                summary.MergeFrom(raw)
                            }
                        }
                        if cand is ImportedTypeSymbol impOp &&
                            impOp.ClrType is {} opClr &&
                            !IsModeledFrameworkType(opClr, opClr.FullName ?? "") {
                            summary.WritesAnyStorage = true
                            return
                        }
                    }
                }
                return
            }
            case idxExpr is IndexExpressionSyntax {
                ScanCalleeSyntaxNode(
                    idxExpr.Target,
                    receiverExpr,
                    receiverIsType,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    summary,
                    ref hitCycle
                )
                for idx in idxExpr.Indices {
                    ScanCalleeSyntaxNode(
                        idx,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
                let indexedType = InferCalleeExpressionType(
                    idxExpr.Target,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                if StripAllNullability(indexedType) is StructSymbol indexedStruct {
                    for property in indexedStruct.Properties {
                        if property.IsIndexer && property.GetterSymbol is {} getter {
                            let effects = GetFunctionEffectSummaryCore(
                                getter,
                                includeOverrides: true,
                                visiting,
                                out var cycle
                            )
                            hitCycle = hitCycle || cycle
                            summary.MergeFrom(
                                ApplyReceiverAndMethodSubstitution(
                                    effects,
                                    indexedStruct,
                                    getter,
                                    ImmutableArray[TypeSymbol].Empty
                                )
                            )
                        }
                    }
                }
                return
            }
            default {
                for child in node.GetChildren() {
                    ScanCalleeSyntaxNode(
                        child,
                        nil,
                        false,
                        origCallee,
                        enclosingType,
                        isConstructor,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        refLocalsFromParams,
                        refLocalsExternal,
                        localFunctions,
                        visitingLocalFunctions,
                        visiting,
                        summary,
                        ref hitCycle
                    )
                }
            }
        }
    }

    private func ResolveCalleeSyntaxCallbackEffects(
        callSummary CallEffectSummary,
        callArguments SeparatedSyntaxList[ExpressionSyntax],
        defaultLambdaParamType TypeSymbol?,
        origCallee FunctionSymbol,
        enclosingType TypeSymbol?,
        parameters Dictionary[string, ParameterSymbol],
        calleeTypeParams Dictionary[string, TypeParameterSymbol],
        localTypes Dictionary[string, TypeSymbol?],
        refLocalsFromParams HashSet[string],
        refLocalsExternal Dictionary[string, TypeSymbol?],
        localFunctions Dictionary[string, SyntaxNode],
        visitingLocalFunctions HashSet[string],
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        if !callSummary.InvokesCallbackParameter || callSummary.WritesAnyStorage {
            summary.MergeFrom(callSummary)
            return
        }
        let cleaned = CallEffectSummary()
        cleaned.MergeFrom(callSummary)
        cleaned.InvokesCallbackParameter = false
        summary.MergeFrom(cleaned)
        for arg in callArguments {
            var cur = if arg is NamedArgumentExpressionSyntax namedArg {
                namedArg.Expression
            } else {
                arg
            }
            while cur is ParenthesizedExpressionSyntax paren {
                cur = paren.Expression
            }
            while cur is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.BangBangToken}} bang {
                cur = bang.Operand
            }
            if cur is LambdaExpressionSyntax lam {
                for p in lam.Parameters {
                    if p.Identifier is {} pId && pId.ValueText.Length > 0 {
                        localTypes[pId.ValueText] = if p.Type != nil {
                            ResolveCalleeTypeClause(p.Type, calleeTypeParams)
                        } else {
                            defaultLambdaParamType
                        }
                        refLocalsFromParams.Add(pId.ValueText)
                    }
                }
                if lam.Body != nil {
                    CollectCalleeFreshLocals(lam.Body, refLocalsFromParams)
                }
                let lamSummary = CallEffectSummary()
                ScanCalleeSyntaxNode(
                    lam.Body,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    false,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    lamSummary,
                    ref hitCycle
                )
                summary.MergeFrom(lamSummary)
            } else if cur is FunctionLiteralExpressionSyntax fl {
                for p in fl.Parameters {
                    if p.Identifier is {} pId && pId.ValueText.Length > 0 {
                        localTypes[pId.ValueText] = if p.Type != nil {
                            ResolveCalleeTypeClause(p.Type, calleeTypeParams)
                        } else {
                            defaultLambdaParamType
                        }
                        refLocalsFromParams.Add(pId.ValueText)
                    }
                }
                if fl.Body != nil {
                    CollectCalleeFreshLocals(fl.Body, refLocalsFromParams)
                }
                let flSummary = CallEffectSummary()
                ScanCalleeSyntaxNode(
                    fl.Body,
                    nil,
                    false,
                    origCallee,
                    enclosingType,
                    false,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    localFunctions,
                    visitingLocalFunctions,
                    visiting,
                    flSummary,
                    ref hitCycle
                )
                summary.MergeFrom(flSummary)
            } else if cur is NameExpressionSyntax nameArg {
                let argName = nameArg.IdentifierToken.ValueText
                if (parameters.TryGetValue(argName, out var pSym) && IsCallableMemberType(pSym.Type)) ||
                    refLocalsFromParams.Contains(argName) {
                    summary.InvokesCallbackParameter = true
                } else if localFunctions.TryGetValue(argName, out var lfBody) {
                    if visitingLocalFunctions.Add(argName) {
                        ScanCalleeSyntaxNode(
                            lfBody,
                            nil,
                            false,
                            origCallee,
                            enclosingType,
                            false,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            refLocalsFromParams,
                            refLocalsExternal,
                            localFunctions,
                            visitingLocalFunctions,
                            visiting,
                            summary,
                            ref hitCycle
                        )
                    }
                } else if $scope.TryLookupSymbol(argName) is GlobalVariableSymbol gv && IsCallableMemberType(gv.Type) {
                    summary.WritesAnyStorage = true
                    return
                } else if localTypes.TryGetValue(argName, out var lt) && IsCallableMemberType(lt) {
                    summary.WritesAnyStorage = true
                    return
                } else if !parameters.ContainsKey(argName) && !localTypes.ContainsKey(argName) {
                    for fn in $scope.TryLookupFunctions(argName) {
                        let raw = GetFunctionEffectSummaryCore(fn, includeOverrides: false, visiting, out var c)
                        if c {
                            hitCycle = true
                        }
                        summary.MergeFrom(raw)
                    }
                    let index = GetCompilationMethodsByName()
                    if index.TryGetValue(argName, out var methods) {
                        for m in methods {
                            if m.Declaration != nil || m.LocalDeclaration != nil {
                                let raw = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out var c)
                                if c {
                                    hitCycle = true
                                }
                                summary.MergeFrom(raw)
                            }
                        }
                    }
                }
            } else if cur is AccessorExpressionSyntax {
                let argType = InferCalleeExpressionType(
                    cur,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                if IsCallableMemberType(argType) {
                    summary.WritesAnyStorage = true
                    return
                }
            }
        }
    }

    private func IsCalleeNilSyntax(expr ExpressionSyntax?) bool {
        var cur = expr
        while cur is ParenthesizedExpressionSyntax paren {
            cur = paren.Expression
        }
        return cur is LiteralExpressionSyntax lit && lit.LiteralToken.Kind == SyntaxKind.NilKeyword
    }

    private func TryGetNilCheckTargetName(cond ExpressionSyntax?, out targetName string) bool {
        targetName = ""
        var cur = cond
        while cur is ParenthesizedExpressionSyntax paren {
            cur = paren.Expression
        }
        if cur is BinaryExpressionSyntax bin && bin.OperatorToken.Kind == SyntaxKind.EqualsEqualsToken {
            if IsCalleeNilSyntax(bin.Right) && bin.Left is NameExpressionSyntax leftName {
                targetName = leftName.IdentifierToken.ValueText
                return targetName.Length > 0
            }
            if IsCalleeNilSyntax(bin.Left) && bin.Right is NameExpressionSyntax rightName {
                targetName = rightName.IdentifierToken.ValueText
                return targetName.Length > 0
            }
        }
        return false
    }

    private func TryGetSimpleAssignmentValueForTarget(
        expr ExpressionSyntax?,
        targetName string,
        out rhs ExpressionSyntax?
    ) bool {
        rhs = nil
        var cur = expr
        while cur is ParenthesizedExpressionSyntax paren {
            cur = paren.Expression
        }
        if cur is AssignmentExpressionSyntax assign && assign.IdentifierToken.ValueText == targetName {
            rhs = assign.Expression
            return true
        }
        return false
    }

    private func IsPrivateFieldOfStruct(owner StructSymbol, name string) bool {
        for level in owner.GetHierarchy() {
            for f in level.Fields {
                if f.Name == name && f.Accessibility == Accessibility.Private {
                    return true
                }
            }
            for sf in level.StaticFields {
                if sf.Name == name && sf.Accessibility == Accessibility.Private {
                    return true
                }
            }
        }
        return false
    }

    private func IsCallableFieldOfStruct(owner StructSymbol, name string) bool {
        for level in owner.GetHierarchy() {
            for f in level.Fields {
                if f.Name == name && IsCallableMemberType(f.Type) {
                    return true
                }
            }
            for sf in level.StaticFields {
                if sf.Name == name && IsCallableMemberType(sf.Type) {
                    return true
                }
            }
        }
        return false
    }

    private func TryGetUnmodifiedCallableFieldBody(owner StructSymbol, name string, out body SyntaxNode?) bool {
        body = nil
        var initExpr ExpressionSyntax? = nil
        for level in owner.GetHierarchy() {
            let def = level.Definition ?? level
            if def.Declaration is {} decl {
                for fDecl in decl.Fields {
                    if fDecl.Identifier.ValueText == name {
                        initExpr = fDecl.Initializer
                        break
                    }
                }
            }
            if initExpr != nil {
                break
            }
        }
        if initExpr == nil {
            return false
        }
        var unwrapped = initExpr
        while unwrapped is ParenthesizedExpressionSyntax paren {
            unwrapped = paren.Expression
        }
        if unwrapped is FunctionLiteralExpressionSyntax fl {
            body = fl.Body
        } else if unwrapped is LambdaExpressionSyntax lam {
            body = lam.Body
        } else {
            return false
        }
        if body == nil || CompilationWritesFieldName(name) {
            body = nil
            return false
        }
        return true
    }

    private func CompilationWritesFieldName(fieldName string) bool {
        let seenTrees = HashSet[SyntaxTree](ReferenceEqualityComparer.Instance)
        for s in binderCtx.RootScope.GetDeclaredStructs() {
            let def = s.Definition ?? s
            if def.Declaration is {} decl && seenTrees.Add(decl.SyntaxTree) {
                if SyntaxTreeWritesFieldName(decl.SyntaxTree.Root, fieldName) {
                    return true
                }
            }
        }
        for fn in binderCtx.RootScope.GetDeclaredFunctions() {
            if fn.Declaration is {} decl && seenTrees.Add(decl.SyntaxTree) {
                if SyntaxTreeWritesFieldName(decl.SyntaxTree.Root, fieldName) {
                    return true
                }
            }
        }
        return false
    }

    private func SyntaxTreeWritesFieldName(node SyntaxNode?, fieldName string) bool {
        if node == nil {
            return false
        }
        switch node {
            case fieldAssign is FieldAssignmentExpressionSyntax {
                if fieldAssign.FieldIdentifier.ValueText == fieldName {
                    return true
                }
            }
            case memberFieldAssign is MemberFieldAssignmentExpressionSyntax {
                if memberFieldAssign.FieldIdentifier.ValueText == fieldName {
                    return true
                }
            }
            case assign is AssignmentExpressionSyntax {
                if assign.IdentifierToken.ValueText == fieldName {
                    return true
                }
            }
            case structLit is StructLiteralExpressionSyntax {
                for initSyntax in structLit.Initializers {
                    if initSyntax.FieldIdentifier.ValueText == fieldName {
                        return true
                    }
                }
            }
            case objCreate is ObjectCreationExpressionSyntax {
                for initSyntax in objCreate.Initializers {
                    if initSyntax.PropertyIdentifier.ValueText == fieldName {
                        return true
                    }
                }
            }
            case refArg is RefArgumentExpressionSyntax {
                if !refArg.IsInlineDeclaration && SyntaxContainsIdentifierName(refArg.Expression, fieldName) {
                    return true
                }
            }
            case unary is UnaryExpressionSyntax when unary.OperatorToken.Kind == SyntaxKind.AmpersandToken {
                if SyntaxContainsIdentifierName(unary.Operand, fieldName) {
                    return true
                }
            }
            default { }
        }
        for child in node.GetChildren() {
            if SyntaxTreeWritesFieldName(child, fieldName) {
                return true
            }
        }
        return false
    }

    private func UpdateInlineOutVarArgumentTypes(
        call CallExpressionSyntax,
        receiverExpr ExpressionSyntax?,
        recvType TypeSymbol?,
        methodName string,
        enclosingType TypeSymbol?,
        localTypes Dictionary[string, TypeSymbol?],
        refLocalsFromParams HashSet[string]
    ) {
        let isPrivateOwnerReceiver = receiverExpr is NameExpressionSyntax recvName &&
            enclosingType is StructSymbol encS &&
            IsPrivateFieldOfStruct(encS, recvName.IdentifierToken.ValueText)
        for var i = 0; i < call.Arguments.Count; i++ {
            let arg = call.Arguments[i]
            let unwrappedArg = if arg is NamedArgumentExpressionSyntax namedArg {
                namedArg.Expression
            } else {
                arg
            }
            if unwrappedArg is RefArgumentExpressionSyntax{
                IsInlineDeclaration: true,
                DeclaredType: nil,
                DeclarationIdentifier: {} declId
            } &&
                declId
                .ValueText
                .Length > 0 {
                if isPrivateOwnerReceiver {
                    refLocalsFromParams.Add(declId.ValueText)
                }
                let effectiveType = recvType ?? enclosingType
                if GetMethodParameterTypeOnType(effectiveType, methodName, i) is {} outParamType {
                    localTypes[declId.ValueText] = outParamType
                    if isPrivateOwnerReceiver && IsCallableMemberType(outParamType) {
                        refLocalsFromParams.Add(declId.ValueText)
                    }
                }
            }
        }
    }

    private func GetMethodParameterTypeOnType(
        receiverType TypeSymbol?,
        methodName string,
        paramIndex int32
    ) TypeSymbol? {
        let stripped = StripAllNullability(receiverType) ?? receiverType
        switch stripped {
            case nil { }
            case mapType is MapTypeSymbol {
                if methodName == "TryGetValue" && paramIndex == 1 {
                    return mapType.ValueType
                }
            }
            case imp is ImportedTypeSymbol {
                if !imp.TypeArguments.IsDefaultOrEmpty {
                    if methodName == "TryGetValue" && paramIndex == 1 && imp.TypeArguments.Length >= 2 {
                        return imp.TypeArguments[1]
                    }
                    if (methodName is "TryGetTarget" or "TryPeek" or "TryDequeue" or "TryPop") && paramIndex == 0 {
                        return imp.TypeArguments[0]
                    }
                }
            }
            case s is StructSymbol {
                for level in s.GetHierarchy() {
                    for m in level.Methods {
                        if m.Name == methodName && paramIndex < m.Parameters.Length {
                            let pt = s.SubstituteMemberType(m.Parameters[paramIndex].Type) ??
                                level.SubstituteMemberType(m.Parameters[paramIndex].Type) ??
                                m
                                .Parameters[paramIndex]
                                .Type
                            return if pt is ByRefTypeSymbol br {
                                br.PointeeType
                            } else {
                                pt
                            }
                        }
                    }
                    for m in level.StaticMethods {
                        if m.Name == methodName && paramIndex < m.Parameters.Length {
                            let pt = s.SubstituteMemberType(m.Parameters[paramIndex].Type) ??
                                level.SubstituteMemberType(m.Parameters[paramIndex].Type) ??
                                m
                                .Parameters[paramIndex]
                                .Type
                            return if pt is ByRefTypeSymbol br {
                                br.PointeeType
                            } else {
                                pt
                            }
                        }
                    }
                }
                if s.GetHierarchy().Last().ImportedBaseType is {} impBase {
                    return GetMethodParameterTypeOnType(impBase, methodName, paramIndex)
                }
            }
            case iface is InterfaceSymbol {
                for level in iface.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    for m in level.GetMethods(methodName) {
                        if paramIndex < m.Parameters.Length {
                            let pt = iface.SubstituteMemberType(
                                level.SubstituteMemberType(m.Parameters[paramIndex].Type)
                            )
                            return if pt is ByRefTypeSymbol br {
                                br.PointeeType
                            } else {
                                pt
                            }
                        }
                    }
                }
            }
            default { }
        }
        if stripped != nil {
            let clr = (stripped as ImportedTypeSymbol)?.OpenDefinition ?? stripped.ClrType
            if clr != nil && ReflectionType(clr) is {} reflected {
                try {
                    let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
                    for clrMem in reflected.GetMember(methodName, flags) {
                        if clrMem is MethodInfo clrMethod && paramIndex < clrMethod.GetParameters().Length {
                            let pType = MemberLookup.GetClrMethodParameterTypeSymbol(stripped, clrMethod, paramIndex) ??
                                ClrNullability.GetParameterTypeSymbol(clrMethod.GetParameters()[paramIndex])
                            return if pType is ByRefTypeSymbol byRefP {
                                byRefP.PointeeType
                            } else {
                                pType
                            }
                        }
                    }
                } catch (ex NotSupportedException) { }
            }
        }
        let scopeFns = $scope.TryLookupFunctions(methodName)
        for fn in scopeFns {
            if paramIndex < fn.Parameters.Length {
                let pt = fn.Parameters[paramIndex].Type
                return if pt is ByRefTypeSymbol br {
                    br.PointeeType
                } else {
                    pt
                }
            }
        }
        return nil
    }

    private func CombineAccessorLeft(receiverExpr ExpressionSyntax?, acc AccessorExpressionSyntax) ExpressionSyntax {
        if receiverExpr == nil {
            return acc.LeftPart
        }
        return AccessorExpressionSyntax(acc.SyntaxTree, receiverExpr, acc.DotToken, acc.LeftPart)
    }

    private func UnwrapRefTargetName(expr ExpressionSyntax?) string? {
        var cur = expr
        while cur != nil {
            switch cur {
                case paren is ParenthesizedExpressionSyntax {
                    cur = paren.Expression
                }
                case refArg is RefArgumentExpressionSyntax {
                    cur = refArg.Expression
                }
                case unary is UnaryExpressionSyntax when unary
                    .OperatorToken
                    .Kind == SyntaxKind.BangBangToken ||
                    unary
                    .OperatorToken
                    .Kind == SyntaxKind.AmpersandToken {
                    cur = unary.Operand
                }
                case name is NameExpressionSyntax {
                    return name.IdentifierToken.ValueText
                }
                default {
                    return nil
                }
            }
        }
        return nil
    }

    private func RecordCalleePatternBindings(
        pattern PatternSyntax?,
        inputType TypeSymbol?,
        origCallee FunctionSymbol,
        enclosingType TypeSymbol?,
        parameters Dictionary[string, ParameterSymbol],
        calleeTypeParams Dictionary[string, TypeParameterSymbol],
        localTypes Dictionary[string, TypeSymbol?]
    ) {
        if pattern == nil {
            return
        }
        let nonNullInput = StripAllNullability(inputType) ?? inputType
        switch pattern {
            case typePat is TypePatternSyntax {
                let patType = ResolveCalleeTypeClause(typePat.Type, calleeTypeParams) ?? nonNullInput
                if typePat.BindingIdentifier is {} bindId && bindId.ValueText.Length > 0 {
                    localTypes[bindId.ValueText] = patType
                }
                if typePat.PropertyPattern is {} propPat {
                    RecordCalleePatternBindings(
                        propPat,
                        patType,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes
                    )
                }
            }
            case propPat is PropertyPatternSyntax {
                if propPat.BindingIdentifier is {} bindId && bindId.ValueText.Length > 0 {
                    localTypes[bindId.ValueText] = nonNullInput
                }
                for field in propPat.Fields {
                    let fieldType = if nonNullInput != nil {
                        GetMemberTypeOnType(nonNullInput, field.Identifier.ValueText)
                    } else {
                        default(TypeSymbol?)
                    }
                    RecordCalleePatternBindings(
                        field.Pattern,
                        fieldType,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes
                    )
                }
            }
            case varPat is VarPatternSyntax {
                if varPat.BindingIdentifier is {} bindId && bindId.ValueText.Length > 0 {
                    localTypes[bindId.ValueText] = inputType
                }
            }
            case tcPat is TypeOrConstantPatternSyntax {
                let patType = ResolveCalleeTypeClause(tcPat.CandidateType, calleeTypeParams) ?? nonNullInput
                if tcPat.PropertyPattern is {} propPat {
                    RecordCalleePatternBindings(
                        propPat,
                        patType,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes
                    )
                }
            }
            case binPat is BinaryPatternSyntax {
                RecordCalleePatternBindings(
                    binPat.Left,
                    inputType,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes
                )
                RecordCalleePatternBindings(
                    binPat.Right,
                    inputType,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes
                )
            }
            case parenPat is ParenthesizedPatternSyntax {
                RecordCalleePatternBindings(
                    parenPat.Pattern,
                    inputType,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes
                )
            }
            case notPat is NotPatternSyntax {
                RecordCalleePatternBindings(
                    notPat.Pattern,
                    inputType,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes
                )
            }
            case listPat is ListPatternSyntax {
                let elemType = GetElementOrIndexerTypeOf(nonNullInput)
                for elem in listPat.Elements {
                    RecordCalleePatternBindings(
                        elem,
                        elemType,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes
                    )
                }
            }
            case slicePat is SlicePatternSyntax {
                if slicePat.CaptureIdentifier is {} capId && capId.ValueText.Length > 0 {
                    localTypes[capId.ValueText] = nonNullInput
                }
                if slicePat.Pattern is {} subPat {
                    RecordCalleePatternBindings(
                        subPat,
                        nonNullInput,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes
                    )
                }
            }
            default { }
        }
    }

    private func IsKnownEffectFreeIterable(collType TypeSymbol?) bool {
        let stripped = StripAllNullability(collType) ?? collType
        switch stripped {
            case nil {
                return false
            }
            case ArrayTypeSymbol, SliceTypeSymbol, RectangularArrayTypeSymbol, SequenceTypeSymbol {
                return true
            }
            case imp is ImportedTypeSymbol {
                let openName = (imp.OpenDefinition ?? imp.ClrType)?.FullName ?? ""
                return openName is "System.Collections.Generic.List`1" or
                    "System.Span`1" or
                    "System.ReadOnlySpan`1" or
                    "System.Collections.Immutable.ImmutableArray`1" or
                    "System.Collections.Generic.Dictionary`2" or
                    "System.Collections.Generic.HashSet`1" or
                    "System.Collections.Generic.Queue`1" or
                    "System.Collections.Generic.Stack`1" or
                    "System.Collections.Generic.LinkedList`1"
            }
            default {
                if object.Equals(stripped, TypeSymbol.String) {
                    return true
                }
                if stripped?.ClrType is {} clr {
                    if clr.IsArray || clr.FullName == "System.String" {
                        return true
                    }
                    if clr.IsGenericType {
                        let openName = clr.GetGenericTypeDefinition().FullName ?? ""
                        return openName is "System.Collections.Generic.List`1" or
                            "System.Span`1" or
                            "System.ReadOnlySpan`1" or
                            "System.Collections.Immutable.ImmutableArray`1" or
                            "System.Collections.Generic.Dictionary`2" or
                            "System.Collections.Generic.HashSet`1" or
                            "System.Collections.Generic.Queue`1" or
                            "System.Collections.Generic.Stack`1" or
                            "System.Collections.Generic.LinkedList`1"
                    }
                }
                return false
            }
        }
    }

    private func HasExplicitStructLayout(def StructSymbol) bool {
        if def.LayoutMetadata is {} layout {
            return layout.Layout == System.Runtime.InteropServices.LayoutKind.Explicit
        }
        if def.Declaration is {} decl {
            for annotation in decl.Annotations {
                if annotation.ToString().Contains("StructLayout", StringComparison.Ordinal) {
                    return true
                }
            }
        }
        return false
    }

    private func CanFieldBeAliasedByRef(owner StructSymbol, field FieldSymbol) bool {
        if field.ExplicitOffset != nil {
            return true
        }
        let def = owner.Definition ?? owner
        if HasExplicitStructLayout(def) {
            return true
        }
        if field.Accessibility == Accessibility.Private {
            return StructTakesReferenceToMemberName(def, field.Name)
        }
        if def.Accessibility == Accessibility.Private && def.ContainingType is StructSymbol outer {
            let outerDef = outer.Definition ?? outer
            return StructTakesReferenceToMemberName(def, field.Name) ||
                StructTakesReferenceToMemberName(outerDef, field.Name)
        }
        return true
    }

    private func CanPropertyBeAliasedByRef(owner StructSymbol, prop PropertySymbol) bool {
        if prop.ReturnRefKind != RefKind.None || prop.GetterSymbol?.ReturnRefKind == RefKind.Ref {
            return true
        }
        let def = owner.Definition ?? owner
        if HasExplicitStructLayout(def) {
            return true
        }
        let origProp = prop.OriginalDefinition ?? prop
        if !origProp.IsAutoProperty {
            if origProp.SetterBodySyntax != nil || prop.SetterBodySyntax != nil {
                return false
            }
            return true
        }
        if origProp.BackingField is {} bf && bf.Accessibility != Accessibility.Private {
            return true
        }
        return StructTakesReferenceToMemberName(def, origProp.Name)
    }

    private func StructTakesReferenceToMemberName(def StructSymbol, memberName string) bool {
        for m in def.Methods {
            if SyntaxTreeTakesReferenceToName(m.Declaration?.Body, memberName, m.ReturnRefKind != RefKind.None) {
                return true
            }
        }
        for sm in def.StaticMethods {
            if SyntaxTreeTakesReferenceToName(sm.Declaration?.Body, memberName, sm.ReturnRefKind != RefKind.None) {
                return true
            }
        }
        for ctor in def.EffectiveExplicitConstructors {
            if SyntaxTreeTakesReferenceToName(ctor.Declaration?.Body, memberName, false) {
                return true
            }
        }
        for p in def.Properties {
            if SyntaxTreeTakesReferenceToName(p.GetterBodySyntax, memberName, p.ReturnRefKind != RefKind.None) ||
                SyntaxTreeTakesReferenceToName(p.SetterBodySyntax, memberName, false) {
                return true
            }
        }
        for sp in def.StaticProperties {
            if SyntaxTreeTakesReferenceToName(sp.GetterBodySyntax, memberName, sp.ReturnRefKind != RefKind.None) ||
                SyntaxTreeTakesReferenceToName(sp.SetterBodySyntax, memberName, false) {
                return true
            }
        }
        return false
    }

    private func SyntaxTreeTakesReferenceToName(node SyntaxNode?, memberName string, enclosingReturnsByRef bool) bool {
        if node == nil {
            return false
        }
        if node is AccessorExpressionSyntax atomicAcc &&
            atomicAcc.LeftPart is NameExpressionSyntax atomicRecv &&
            (atomicRecv.IdentifierToken.ValueText is "Volatile" or "Interlocked" or "ImmutableInterlocked") &&
            atomicAcc.RightPart is CallExpressionSyntax atomicCall &&
            (
            atomicCall
                .Identifier
                .ValueText is "Read" or
                "Write" or
                "CompareExchange" or
                "Exchange" or
                "Increment" or
                "Decrement" or
                "Add" or
                "InterlockedInitialize"
        ) {
            for var i = 1; i < atomicCall.Arguments.Count; i++ {
                if SyntaxTreeTakesReferenceToName(atomicCall.Arguments[i], memberName, enclosingReturnsByRef) {
                    return true
                }
            }
            return false
        }
        switch node {
            case refArg is RefArgumentExpressionSyntax {
                if !refArg.IsInlineDeclaration && SyntaxContainsIdentifierName(refArg.Expression, memberName) {
                    return true
                }
            }
            case condRef is ConditionalRefArgumentExpressionSyntax {
                if SyntaxContainsIdentifierName(condRef.WhenTrue, memberName) ||
                    SyntaxContainsIdentifierName(condRef.WhenFalse, memberName) {
                    return true
                }
            }
            case unary is UnaryExpressionSyntax when unary.OperatorToken.Kind == SyntaxKind.AmpersandToken {
                if SyntaxContainsIdentifierName(unary.Operand, memberName) {
                    return true
                }
            }
            case varDecl is VariableDeclarationSyntax when varDecl.HasRefKindModifier {
                if SyntaxContainsIdentifierName(varDecl.Initializer, memberName) {
                    return true
                }
            }
            case ret is ReturnStatementSyntax when enclosingReturnsByRef || ret.IsRefReturn {
                if SyntaxContainsIdentifierName(ret.Expression, memberName) {
                    return true
                }
            }
            default { }
        }
        for child in node.GetChildren() {
            if SyntaxTreeTakesReferenceToName(child, memberName, enclosingReturnsByRef) {
                return true
            }
        }
        return false
    }

    private func SyntaxContainsIdentifierName(node SyntaxNode?, name string) bool {
        if node == nil {
            return false
        }
        if node is NameExpressionSyntax nameExpr && nameExpr.IdentifierToken.ValueText == name {
            return true
        }
        for child in node.GetChildren() {
            if SyntaxContainsIdentifierName(child, name) {
                return true
            }
        }
        return false
    }

    private func RecordConstructorSelfMemberWrite(
        enclosingType TypeSymbol?,
        fieldName string,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        if enclosingType is StructSymbol s {
            for level in s.GetHierarchy() {
                for prop in level.Properties {
                    if prop.Name == fieldName &&
                        !prop.IsStatic &&
                        !prop.IsAutoProperty &&
                        prop.SetterSymbol is {} setter {
                        let setterSummary = GetFunctionEffectSummaryCore(
                            setter,
                            includeOverrides: false,
                            visiting,
                            out var c
                        )
                        if c {
                            hitCycle = true
                        }
                        summary.MergeFrom(
                            ApplyReceiverAndMethodSubstitution(
                                setterSummary,
                                s,
                                setter,
                                ImmutableArray[TypeSymbol].Empty
                            )
                        )
                    }
                }
                for sField in level.StaticFields {
                    if sField.Name == fieldName {
                        if CanFieldBeAliasedByRef(level, sField) {
                            summary.AddFieldType(level.SubstituteMemberType(sField.Type) ?? sField.Type)
                        }
                    }
                }
                for sProp in level.StaticProperties {
                    if sProp.Name == fieldName {
                        if CanPropertyBeAliasedByRef(level, sProp) {
                            summary.AddFieldType(level.SubstituteMemberType(sProp.Type) ?? sProp.Type)
                        }
                        if sProp.SetterSymbol is {} setter {
                            let setterSummary = GetFunctionEffectSummaryCore(
                                setter,
                                includeOverrides: false,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(setterSummary)
                        }
                    }
                }
            }
        }
    }

    private func RecordCalleePlainNameWrite(
        name string,
        origCallee FunctionSymbol,
        enclosingType TypeSymbol?,
        isConstructor bool,
        parameters Dictionary[string, ParameterSymbol],
        localTypes Dictionary[string, TypeSymbol?],
        refLocalsFromParams HashSet[string],
        refLocalsExternal Dictionary[string, TypeSymbol?],
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        if refLocalsExternal.TryGetValue(name, out var extType) {
            if extType != nil {
                summary.AddFieldType(extType)
                summary.AddElementType(extType)
            } else {
                summary.WritesAnyStorage = true
            }
            return
        }
        if refLocalsFromParams.Contains(name) || localTypes.ContainsKey(name) {
            return
        }
        if parameters.TryGetValue(name, out var param) {
            if (name == "this" || object.ReferenceEquals(param, origCallee.ExplicitReceiverParameter)) &&
                !isConstructor {
                let pType = StripAllNullability(param.Type) ?? param.Type
                if pType is StructSymbol{IsClass: false} valStruct {
                    summary.AddFieldType(valStruct)
                }
            }
            return
        }
        if origCallee.HasCaptures {
            summary.WritesAnyStorage = true
            return
        }
        if enclosingType is StructSymbol s {
            if isConstructor {
                for level in s.GetHierarchy() {
                    for f in level.Fields {
                        if f.Name == name && !f.IsStatic {
                            return
                        }
                    }
                    for p in level.Properties {
                        if p.Name == name && !p.IsStatic {
                            if !p.IsAutoProperty && p.SetterSymbol is {} setter {
                                let setterSummary = GetFunctionEffectSummaryCore(
                                    setter,
                                    includeOverrides: false,
                                    visiting,
                                    out var c
                                )
                                if c {
                                    hitCycle = true
                                }
                                summary.MergeFrom(
                                    ApplyReceiverAndMethodSubstitution(
                                        setterSummary,
                                        s,
                                        setter,
                                        ImmutableArray[TypeSymbol].Empty
                                    )
                                )
                            }
                            return
                        }
                    }
                }
            }
            var foundOnOwner = false
            for level in s.GetHierarchy() {
                for f in level.Fields {
                    if f.Name == name {
                        foundOnOwner = true
                        if CanFieldBeAliasedByRef(level, f) {
                            summary.AddFieldType(level.SubstituteMemberType(f.Type) ?? f.Type)
                        }
                    }
                }
                for sf in level.StaticFields {
                    if sf.Name == name {
                        foundOnOwner = true
                        if CanFieldBeAliasedByRef(level, sf) {
                            summary.AddFieldType(level.SubstituteMemberType(sf.Type) ?? sf.Type)
                        }
                    }
                }
                for p in level.Properties {
                    if p.Name == name {
                        foundOnOwner = true
                        if CanPropertyBeAliasedByRef(level, p) {
                            summary.AddFieldType(level.SubstituteMemberType(p.Type) ?? p.Type)
                        }
                        if p.SetterSymbol is {} setter {
                            let setterSummary = GetFunctionEffectSummaryCore(
                                setter,
                                includeOverrides: true,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(
                                ApplyReceiverAndMethodSubstitution(
                                    setterSummary,
                                    s,
                                    setter,
                                    ImmutableArray[TypeSymbol].Empty
                                )
                            )
                        }
                    }
                }
                for sp in level.StaticProperties {
                    if sp.Name == name {
                        foundOnOwner = true
                        if CanPropertyBeAliasedByRef(level, sp) {
                            summary.AddFieldType(level.SubstituteMemberType(sp.Type) ?? sp.Type)
                        }
                        if sp.SetterSymbol is {} setter {
                            let setterSummary = GetFunctionEffectSummaryCore(
                                setter,
                                includeOverrides: false,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(setterSummary)
                        }
                    }
                }
            }
            if !foundOnOwner && s.GetHierarchy().Last().ImportedBaseType is {} impBase {
                RecordCalleeMemberWriteOnType(impBase, name, false, visiting, summary, ref hitCycle)
                return
            }
            if foundOnOwner {
                return
            }
        }
        if enclosingType is InterfaceSymbol iface {
            for level in iface.SelfAndAllBaseInterfaces() {
                level.EnsureMembersResolved()
                for p in level.Properties {
                    if p.Name == name {
                        summary.AddFieldType(level.SubstituteMemberType(p.Type))
                        if p.SetterSymbol is {} setter {
                            let setterSummary = GetFunctionEffectSummaryCore(
                                setter,
                                includeOverrides: !p.IsStatic,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(
                                ApplyReceiverAndMethodSubstitution(
                                    setterSummary,
                                    iface,
                                    setter,
                                    ImmutableArray[TypeSymbol].Empty
                                )
                            )
                        } else {
                            summary.WritesAnyStorage = true
                        }
                        return
                    }
                }
                for sf in level.StaticFields {
                    if sf.Name == name {
                        summary.AddFieldType(level.SubstituteMemberType(sf.Type))
                        return
                    }
                }
            }
        }
        if $scope.TryLookupSymbol(name) is {} sym {
            switch sym {
                case g is GlobalVariableSymbol {
                    summary.AddFieldType(g.Type)
                    return
                }
                case f is ImplicitFieldVariableSymbol {
                    summary.AddFieldType(f.Field.Type)
                    return
                }
                case sf is ImplicitStaticFieldVariableSymbol {
                    summary.AddFieldType(sf.Field.Type)
                    return
                }
                case p is ImplicitPropertyVariableSymbol {
                    summary.AddFieldType(p.Property.Type)
                    if p.Property.SetterSymbol is {} setter {
                        let setterSummary = GetFunctionEffectSummaryCore(
                            setter,
                            includeOverrides: true,
                            visiting,
                            out var c
                        )
                        if c {
                            hitCycle = true
                        }
                        summary.MergeFrom(setterSummary)
                    }
                    return
                }
                case sp is ImplicitStaticPropertyVariableSymbol {
                    summary.AddFieldType(sp.Property.Type)
                    if sp.Property.SetterSymbol is {} setter {
                        let setterSummary = GetFunctionEffectSummaryCore(
                            setter,
                            includeOverrides: false,
                            visiting,
                            out var c
                        )
                        if c {
                            hitCycle = true
                        }
                        summary.MergeFrom(setterSummary)
                    }
                    return
                }
                default { }
            }
        }
        if TryResolveBareFallbackMember(name, out var fallbackType, out var isProp, out _, out _, forWrite: true) &&
            fallbackType != nil {
            summary.AddFieldType(fallbackType)
            if isProp {
                summary.WritesAnyStorage = true
            }
            return
        }
        summary.WritesAnyStorage = true
    }

    private func RecordCalleeExpressionTargetWrite(
        target ExpressionSyntax?,
        origCallee FunctionSymbol,
        enclosingType TypeSymbol?,
        isConstructor bool,
        parameters Dictionary[string, ParameterSymbol],
        calleeTypeParams Dictionary[string, TypeParameterSymbol],
        localTypes Dictionary[string, TypeSymbol?],
        refLocalsFromParams HashSet[string],
        refLocalsExternal Dictionary[string, TypeSymbol?],
        localFunctions Dictionary[string, SyntaxNode],
        visitingLocalFunctions HashSet[string],
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        var cur = target
        while cur is ParenthesizedExpressionSyntax paren {
            cur = paren.Expression
        }
        while cur is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.BangBangToken}} bang {
            cur = bang.Operand
        }
        switch cur {
            case nil { }
            case name is NameExpressionSyntax {
                RecordCalleePlainNameWrite(
                    name.IdentifierToken.ValueText,
                    origCallee,
                    enclosingType,
                    isConstructor,
                    parameters,
                    localTypes,
                    refLocalsFromParams,
                    refLocalsExternal,
                    visiting,
                    summary,
                    ref hitCycle
                )
            }
            case acc is AccessorExpressionSyntax {
                SplitRightmostMemberAccess(acc, out var recvExpr, out var rightExpr)
                if rightExpr is NameExpressionSyntax memberName {
                    let isFreshRecv = IsCalleeFreshLocalExpression(recvExpr, refLocalsFromParams)
                    let recvType = InferCalleeExpressionType(
                        recvExpr,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out var isTypeRecv
                    )
                    RecordCalleeMemberWriteOnType(
                        recvType,
                        memberName.IdentifierToken.ValueText,
                        isTypeRecv,
                        visiting,
                        summary,
                        ref hitCycle,
                        isFreshReceiver: isFreshRecv,
                        isCompound: true
                    )
                } else if rightExpr is IndexExpressionSyntax idxRight {
                    let combinedIdxTarget = if recvExpr != nil {
                        AccessorExpressionSyntax(acc.SyntaxTree, recvExpr, acc.DotToken, idxRight.Target)
                    } else {
                        idxRight.Target
                    }
                    let isFreshTarget = IsCalleeFreshLocalExpression(combinedIdxTarget, refLocalsFromParams)
                    let targetType = InferCalleeExpressionType(
                        combinedIdxTarget,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    )
                    RecordCalleeElementWriteOnType(
                        targetType,
                        visiting,
                        summary,
                        ref hitCycle,
                        isFreshReceiver: isFreshTarget,
                        isCompound: true
                    )
                } else {
                    let exprType = InferCalleeExpressionType(
                        acc,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    )
                    if exprType != nil {
                        summary.AddFieldType(exprType)
                        summary.AddElementType(exprType)
                    } else {
                        summary.WritesAnyStorage = true
                    }
                }
            }
            case idx is IndexExpressionSyntax {
                let isFreshTarget = IsCalleeFreshLocalExpression(idx.Target, refLocalsFromParams)
                let targetType = InferCalleeExpressionType(
                    idx.Target,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                RecordCalleeElementWriteOnType(
                    targetType,
                    visiting,
                    summary,
                    ref hitCycle,
                    isFreshReceiver: isFreshTarget,
                    isCompound: true
                )
            }
            default {
                let exprType = InferCalleeExpressionType(
                    cur,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                if exprType != nil {
                    summary.AddFieldType(exprType)
                    summary.AddElementType(exprType)
                } else {
                    summary.WritesAnyStorage = true
                }
            }
        }
    }

    private func SplitRightmostMemberAccess(
        acc AccessorExpressionSyntax,
        out receiverExpr ExpressionSyntax?,
        out rightmost ExpressionSyntax
    ) {
        var prefix ExpressionSyntax? = acc.LeftPart
        var right ExpressionSyntax = acc.RightPart
        while right is AccessorExpressionSyntax nested {
            prefix = if prefix != nil {
                AccessorExpressionSyntax(acc.SyntaxTree, prefix, acc.DotToken, nested.LeftPart)
            } else {
                nested.LeftPart
            }
            right = nested.RightPart
        }
        receiverExpr = prefix
        rightmost = right
    }

    private func RecordCalleeMemberWriteOnType(
        receiverType TypeSymbol?,
        memberName string,
        isStatic bool,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool,
        isFreshReceiver bool = false,
        isCompound bool = false
    ) {
        let stripped = StripAllNullability(receiverType) ?? receiverType
        if stripped == TypeSymbol.Error {
            summary.WritesAnyStorage = true
            return
        }
        if stripped == nil {
            if isFreshReceiver {
                return
            }
            if memberName is "Value" or "ValueRef" {
                summary.WritesAnyStorage = true
                return
            }
            var anyFound = false
            for s in binderCtx.RootScope.GetDeclaredStructs() {
                for f in s.Fields {
                    if f.Name == memberName {
                        anyFound = true
                        if CanFieldBeAliasedByRef(s, f) {
                            summary.AddFieldType(f.Type)
                        }
                    }
                }
                for sf in s.StaticFields {
                    if sf.Name == memberName {
                        anyFound = true
                        if CanFieldBeAliasedByRef(s, sf) {
                            summary.AddFieldType(sf.Type)
                        }
                    }
                }
                for p in s.Properties {
                    if p.Name == memberName {
                        anyFound = true
                        if CanPropertyBeAliasedByRef(s, p) {
                            summary.AddFieldType(p.Type)
                        }
                        if p.SetterSymbol is {} setter {
                            let setterSummary = GetFunctionEffectSummaryCore(
                                setter,
                                includeOverrides: false,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(setterSummary)
                        }
                    }
                }
                for sp in s.StaticProperties {
                    if sp.Name == memberName {
                        anyFound = true
                        if CanPropertyBeAliasedByRef(s, sp) {
                            summary.AddFieldType(sp.Type)
                        }
                        if sp.SetterSymbol is {} setter {
                            let setterSummary = GetFunctionEffectSummaryCore(
                                setter,
                                includeOverrides: false,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(setterSummary)
                        }
                    }
                }
            }
            for iface in binderCtx.RootScope.GetDeclaredInterfaces() {
                iface.EnsureMembersResolved()
                for p in iface.Properties {
                    if p.Name == memberName {
                        anyFound = true
                        summary.AddFieldType(p.Type)
                        if p.SetterSymbol is {} setter {
                            let setterSummary = GetFunctionEffectSummaryCore(
                                setter,
                                includeOverrides: true,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(setterSummary)
                        } else {
                            summary.WritesAnyStorage = true
                        }
                    }
                }
            }
            if !anyFound {
                summary.WritesAnyStorage = true
            }
            return
        }
        switch stripped {
            case tuple is TupleTypeSymbol {
                if isFreshReceiver {
                    return
                }
                if tuple.TryGetElementIndexByName(memberName, out var element) {
                    summary.AddFieldType(tuple.ElementTypes[element])
                    return
                }
                if memberName.StartsWith("Item", StringComparison.Ordinal) && int32.TryParse(
                    memberName.Substring(4),
                    out var position
                ) &&
                    position >= 1 &&
                    position <= tuple
                    .ElementTypes
                    .Length {
                    summary.AddFieldType(tuple.ElementTypes[position - 1])
                    return
                }
                if int32.TryParse(memberName, out var zeroIdx) && zeroIdx >= 0 && zeroIdx < tuple.ElementTypes.Length {
                    summary.AddFieldType(tuple.ElementTypes[zeroIdx])
                    return
                }
                for elemType in tuple.ElementTypes {
                    summary.AddFieldType(elemType)
                }
                return
            }
            case s is StructSymbol {
                var found = false
                for level in s.GetHierarchy() {
                    for f in level.Fields {
                        if f.Name == memberName {
                            found = true
                            if !isFreshReceiver && CanFieldBeAliasedByRef(level, f) {
                                summary.AddFieldType(
                                    s.SubstituteMemberType(f.Type) ?? level.SubstituteMemberType(f.Type) ?? f.Type
                                )
                            }
                        }
                    }
                    for sf in level.StaticFields {
                        if sf.Name == memberName {
                            found = true
                            if CanFieldBeAliasedByRef(level, sf) {
                                summary.AddFieldType(
                                    s.SubstituteMemberType(sf.Type) ?? level.SubstituteMemberType(sf.Type) ?? sf.Type
                                )
                            }
                        }
                    }
                    for p in level.Properties {
                        if p.Name == memberName {
                            found = true
                            if !isFreshReceiver && CanPropertyBeAliasedByRef(level, p) {
                                summary.AddFieldType(
                                    s.SubstituteMemberType(p.Type) ?? level.SubstituteMemberType(p.Type) ?? p.Type
                                )
                            }
                            if isCompound && !p.IsAutoProperty && p.GetterSymbol is {} getter {
                                if isFreshReceiver {
                                    ScanFreshReceiverAccessorBody(getter, s, visiting, summary, ref hitCycle)
                                } else {
                                    let getterSummary = GetFunctionEffectSummaryCore(
                                        getter,
                                        includeOverrides: true,
                                        visiting,
                                        out var gc
                                    )
                                    if gc {
                                        hitCycle = true
                                    }
                                    summary.MergeFrom(
                                        ApplyReceiverAndMethodSubstitution(
                                            getterSummary,
                                            s,
                                            getter,
                                            ImmutableArray[TypeSymbol].Empty
                                        )
                                    )
                                }
                            }
                            if (!isFreshReceiver || !p.IsAutoProperty) && p.SetterSymbol is {} setter {
                                if isFreshReceiver {
                                    ScanFreshReceiverAccessorBody(setter, s, visiting, summary, ref hitCycle)
                                } else {
                                    let setterSummary = GetFunctionEffectSummaryCore(
                                        setter,
                                        includeOverrides: true,
                                        visiting,
                                        out var c
                                    )
                                    if c {
                                        hitCycle = true
                                    }
                                    summary.MergeFrom(
                                        ApplyReceiverAndMethodSubstitution(
                                            setterSummary,
                                            s,
                                            setter,
                                            ImmutableArray[TypeSymbol].Empty
                                        )
                                    )
                                }
                            }
                        }
                    }
                    for sp in level.StaticProperties {
                        if sp.Name == memberName {
                            found = true
                            if CanPropertyBeAliasedByRef(level, sp) {
                                summary.AddFieldType(
                                    s.SubstituteMemberType(sp.Type) ?? level.SubstituteMemberType(sp.Type) ?? sp.Type
                                )
                            }
                            if sp.SetterSymbol is {} setter {
                                let setterSummary = GetFunctionEffectSummaryCore(
                                    setter,
                                    includeOverrides: false,
                                    visiting,
                                    out var c
                                )
                                if c {
                                    hitCycle = true
                                }
                                summary.MergeFrom(setterSummary)
                            }
                        }
                    }
                }
                if !found && s.GetHierarchy().Last().ImportedBaseType is {} impBase {
                    RecordCalleeMemberWriteOnType(
                        impBase,
                        memberName,
                        isStatic,
                        visiting,
                        summary,
                        ref hitCycle,
                        isFreshReceiver: isFreshReceiver,
                        isCompound: isCompound
                    )
                    return
                }
                if !found && !isFreshReceiver {
                    summary.WritesAnyStorage = true
                }
                return
            }
            case iface is InterfaceSymbol {
                var found = false
                for level in iface.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    for p in level.Properties {
                        if p.Name == memberName {
                            found = true
                            if !isFreshReceiver {
                                summary.AddFieldType(iface.SubstituteMemberType(level.SubstituteMemberType(p.Type)))
                            }
                            if p.SetterSymbol is {} setter {
                                let setterSummary = GetFunctionEffectSummaryCore(
                                    setter,
                                    includeOverrides: !p.IsStatic,
                                    visiting,
                                    out var c
                                )
                                if c {
                                    hitCycle = true
                                }
                                summary.MergeFrom(
                                    ApplyReceiverAndMethodSubstitution(
                                        setterSummary,
                                        iface,
                                        setter,
                                        ImmutableArray[TypeSymbol].Empty
                                    )
                                )
                            } else if !isFreshReceiver {
                                summary.WritesAnyStorage = true
                            }
                        }
                    }
                }
                if !found && !isFreshReceiver {
                    summary.WritesAnyStorage = true
                }
                return
            }
            default { }
        }
        let clr = (stripped as ImportedTypeSymbol)?.OpenDefinition ?? stripped.ClrType
        if clr == nil || ReflectionType(clr) is not{} reflected {
            if !isFreshReceiver {
                summary.WritesAnyStorage = true
            }
            return
        }
        try {
            var found = false
            let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
            for clrMember in reflected.GetMember(memberName, flags) {
                if clrMember is FieldInfo clrField {
                    found = true
                    if !isFreshReceiver {
                        let fType = MemberLookup.GetClrFieldTypeSymbol(stripped, clrField) ??
                            ClrNullability.GetFieldTypeSymbol(clrField)
                        summary.AddFieldType(fType)
                    }
                } else if clrMember is PropertyInfo clrProp && clrProp.GetIndexParameters().Length == 0 {
                    found = true
                    let pType = MemberLookup.GetClrPropertyTypeSymbol(stripped, clrProp) ??
                        ClrNullability.GetPropertyTypeSymbol(clrProp)
                    if !isFreshReceiver {
                        summary.AddFieldType(pType)
                    }
                    if clrProp.SetMethod is {} clrSetter {
                        summary.MergeFrom(
                            AnalyzeImportedMethodEffects(
                                clrSetter,
                                stripped,
                                List[TypeSymbol?]{pType},
                                default(ImmutableArray[TypeSymbol?]),
                                includeOverrides: !isStatic,
                                visiting,
                                receiverIsFreshLocal: isFreshReceiver
                            )
                        )
                    }
                }
            }
            if !found && !isFreshReceiver {
                summary.WritesAnyStorage = true
            }
        } catch (ex NotSupportedException) {
            if !isFreshReceiver {
                summary.WritesAnyStorage = true
            }
        }
    }

    private func RecordCalleeElementWriteOnType(
        targetType TypeSymbol?,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool,
        isFreshReceiver bool = false,
        isCompound bool = false
    ) {
        let stripped = StripAllNullability(targetType) ?? targetType
        if stripped == nil {
            if !isFreshReceiver {
                summary.WritesAnyStorage = true
            }
            return
        }
        if !isFreshReceiver {
            if GetElementOrIndexerTypeOf(stripped) is {} elemType {
                summary.AddElementType(elemType)
            } else {
                summary.WritesAnyStorage = true
            }
        }
        if stripped is StructSymbol s {
            for level in s.GetHierarchy() {
                for p in level.Properties {
                    if p.IsIndexer {
                        if isCompound && p.GetterSymbol is {} getter {
                            if isFreshReceiver {
                                ScanFreshReceiverAccessorBody(getter, s, visiting, summary, ref hitCycle)
                            } else {
                                let getterSummary = GetFunctionEffectSummaryCore(
                                    getter,
                                    includeOverrides: true,
                                    visiting,
                                    out var gc
                                )
                                if gc {
                                    hitCycle = true
                                }
                                summary.MergeFrom(
                                    ApplyReceiverAndMethodSubstitution(
                                        getterSummary,
                                        s,
                                        getter,
                                        ImmutableArray[TypeSymbol].Empty
                                    )
                                )
                            }
                        }
                        if p.SetterSymbol is {} setter {
                            if isFreshReceiver {
                                ScanFreshReceiverAccessorBody(setter, s, visiting, summary, ref hitCycle)
                            } else {
                                let setterSummary = GetFunctionEffectSummaryCore(
                                    setter,
                                    includeOverrides: true,
                                    visiting,
                                    out var c
                                )
                                if c {
                                    hitCycle = true
                                }
                                summary.MergeFrom(
                                    ApplyReceiverAndMethodSubstitution(
                                        setterSummary,
                                        s,
                                        setter,
                                        ImmutableArray[TypeSymbol].Empty
                                    )
                                )
                            }
                        }
                    }
                }
            }
        } else if stripped is InterfaceSymbol iface {
            for level in iface.SelfAndAllBaseInterfaces() {
                level.EnsureMembersResolved()
                for p in level.Properties {
                    if p.IsIndexer {
                        if isCompound && p.GetterSymbol is {} getter {
                            let getterSummary = GetFunctionEffectSummaryCore(
                                getter,
                                includeOverrides: true,
                                visiting,
                                out var gc
                            )
                            if gc {
                                hitCycle = true
                            }
                            summary.MergeFrom(
                                ApplyReceiverAndMethodSubstitution(
                                    getterSummary,
                                    iface,
                                    getter,
                                    ImmutableArray[TypeSymbol].Empty
                                )
                            )
                        }
                        if p.SetterSymbol is {} setter {
                            let setterSummary = GetFunctionEffectSummaryCore(
                                setter,
                                includeOverrides: true,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(
                                ApplyReceiverAndMethodSubstitution(
                                    setterSummary,
                                    iface,
                                    setter,
                                    ImmutableArray[TypeSymbol].Empty
                                )
                            )
                        } else if !isFreshReceiver {
                            summary.WritesAnyStorage = true
                        }
                    }
                }
            }
        } else if !isFreshReceiver && stripped is MapTypeSymbol mapType {
            MergeEqualityOrComparerCallbackEffects("", "set_Item", mapType, nil, visiting, summary)
        } else if !isFreshReceiver && stripped is ImportedTypeSymbol imp {
            let openName = (imp.OpenDefinition ?? imp.ClrType)?.FullName ?? ""
            if openName.StartsWith("System.Collections.Generic.Dictionary`", StringComparison.Ordinal) ||
                openName
                .StartsWith("System.Collections.Generic.IDictionary`", StringComparison.Ordinal) {
                MergeEqualityOrComparerCallbackEffects(openName, "set_Item", imp, nil, visiting, summary)
            }
        }
    }

    private func ScanFreshReceiverAccessorBody(
        accessorFn FunctionSymbol,
        owner StructSymbol,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        if !visiting.Add(accessorFn) {
            hitCycle = true
            return
        }
        var body SyntaxNode? = accessorFn.Declaration?.Body
        if body == nil && accessorFn.AssociatedSymbol is PropertySymbol assocProp {
            let origProp = assocProp.OriginalDefinition ?? assocProp
            if accessorFn.MethodKind == MethodKind.PropertyGet || object.ReferenceEquals(
                assocProp.GetterSymbol,
                accessorFn
            ) ||
                object.ReferenceEquals(origProp.GetterSymbol, accessorFn) {
                body = origProp.GetterBodySyntax ?? assocProp.GetterBodySyntax
            } else {
                body = origProp.SetterBodySyntax ?? assocProp.SetterBodySyntax
            }
        }
        if body != nil {
            let accParams = Dictionary[string, ParameterSymbol](StringComparer.Ordinal)
            for p in accessorFn.Parameters {
                accParams[p.Name] = p
            }
            let accTypeParams = Dictionary[string, TypeParameterSymbol](StringComparer.Ordinal)
            for tp in(owner.Definition ?? owner).TypeParameters {
                accTypeParams[tp.Name] = tp
            }
            let localTypes = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
            let refLocals = HashSet[string](StringComparer.Ordinal)
            let refExt = Dictionary[string, TypeSymbol?](StringComparer.Ordinal)
            let localFns = Dictionary[string, SyntaxNode](StringComparer.Ordinal)
            let visitingLocalFns = HashSet[string](StringComparer.Ordinal)
            CollectCalleeFreshLocals(body, refLocals)
            let accSummary = CallEffectSummary()
            ScanCalleeSyntaxNode(
                body,
                nil,
                false,
                accessorFn,
                owner,
                true,
                accParams,
                accTypeParams,
                localTypes,
                refLocals,
                refExt,
                localFns,
                visitingLocalFns,
                visiting,
                accSummary,
                ref hitCycle
            )
            summary.MergeFrom(
                ApplyReceiverAndMethodSubstitution(accSummary, owner, accessorFn, ImmutableArray[TypeSymbol].Empty)
            )
        }
        visiting.Remove(accessorFn)
    }

    private func RecordCalleeBareReadEffects(
        name string,
        enclosingType TypeSymbol?,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        if enclosingType is StructSymbol s {
            let canHaveSubclass = s.IsClass && (s.IsOpen || s.IsAbstract || s.IsSealedHierarchy)
            for level in s.GetHierarchy() {
                for p in level.Properties {
                    if p.Name == name {
                        if p.GetterSymbol is {} getter {
                            let getterSummary = GetFunctionEffectSummaryCore(
                                getter,
                                includeOverrides: canHaveSubclass,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(
                                ApplyReceiverAndMethodSubstitution(
                                    getterSummary,
                                    s,
                                    getter,
                                    ImmutableArray[TypeSymbol].Empty
                                )
                            )
                        } else if canHaveSubclass {
                            let index = GetCompilationMethodsByName()
                            if index.TryGetValue("get_" + name, out var getters) {
                                for g in getters {
                                    if CandidateMayOverridePropertyOnStruct(g, s) {
                                        let gSummary = GetFunctionEffectSummaryCore(
                                            g,
                                            includeOverrides: false,
                                            visiting,
                                            out var c
                                        )
                                        if c {
                                            hitCycle = true
                                        }
                                        summary.MergeFrom(gSummary)
                                    }
                                }
                            }
                        }
                        return
                    }
                }
                for sp in level.StaticProperties {
                    if sp.Name == name {
                        if sp.GetterSymbol is {} getter {
                            let getterSummary = GetFunctionEffectSummaryCore(
                                getter,
                                includeOverrides: false,
                                visiting,
                                out var c
                            )
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(getterSummary)
                        }
                        return
                    }
                }
            }
        }
        if $scope.TryLookupSymbol(name) is {} sym {
            if sym is ImplicitPropertyVariableSymbol ip && ip.Property.GetterSymbol is {} g1 {
                let s1 = GetFunctionEffectSummaryCore(g1, includeOverrides: true, visiting, out var c1)
                if c1 {
                    hitCycle = true
                }
                summary.MergeFrom(s1)
            } else if sym is ImplicitStaticPropertyVariableSymbol isp && isp.Property.GetterSymbol is {} g2 {
                let s2 = GetFunctionEffectSummaryCore(g2, includeOverrides: false, visiting, out var c2)
                if c2 {
                    hitCycle = true
                }
                summary.MergeFrom(s2)
            }
        }
    }

    private func CandidateMayOverridePropertyOnStruct(getter FunctionSymbol, baseStruct StructSymbol) bool {
        let baseDef = baseStruct.Definition ?? baseStruct
        if (getter.ReceiverType as StructSymbol) is {} candStruct {
            for level in candStruct.GetHierarchy() {
                if object.ReferenceEquals(level.Definition ?? level, baseDef) {
                    return true
                }
            }
        }
        return false
    }

    private func RecordCalleeMemberReadEffects(
        receiverType TypeSymbol?,
        memberName string,
        isStatic bool,
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        let stripped = StripAllNullability(receiverType) ?? receiverType
        if stripped == TypeSymbol.Error {
            summary.WritesAnyStorage = true
            return
        }
        if stripped == nil {
            return
        }
        switch stripped {
            case s is StructSymbol {
                let canHaveSubclass = s.IsClass && (s.IsOpen || s.IsAbstract || s.IsSealedHierarchy)
                for level in s.GetHierarchy() {
                    let props = if isStatic {
                        level.StaticProperties
                    } else {
                        level.Properties
                    }
                    for p in props {
                        if p.Name == memberName {
                            if p.GetterSymbol is {} getter {
                                let getterSummary = GetFunctionEffectSummaryCore(
                                    getter,
                                    includeOverrides: !isStatic && canHaveSubclass,
                                    visiting,
                                    out var c
                                )
                                if c {
                                    hitCycle = true
                                }
                                summary.MergeFrom(
                                    ApplyReceiverAndMethodSubstitution(
                                        getterSummary,
                                        s,
                                        getter,
                                        ImmutableArray[TypeSymbol].Empty
                                    )
                                )
                            } else if !isStatic && canHaveSubclass {
                                let index = GetCompilationMethodsByName()
                                if index.TryGetValue("get_" + memberName, out var getters) {
                                    for g in getters {
                                        if CandidateMayOverridePropertyOnStruct(g, s) {
                                            let gSummary = GetFunctionEffectSummaryCore(
                                                g,
                                                includeOverrides: false,
                                                visiting,
                                                out var c
                                            )
                                            if c {
                                                hitCycle = true
                                            }
                                            summary.MergeFrom(gSummary)
                                        }
                                    }
                                }
                            }
                            return
                        }
                    }
                }
                let hier = s.GetHierarchy()
                if hier.Count > 0 && hier[hier.Count - 1].ImportedBaseType is {} impBase {
                    RecordCalleeMemberReadEffects(impBase, memberName, isStatic, visiting, summary, ref hitCycle)
                }
                return
            }
            case iface is InterfaceSymbol {
                for level in iface.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    for p in level.Properties {
                        if p.Name == memberName {
                            if p.GetterSymbol is {} getter {
                                let getterSummary = GetFunctionEffectSummaryCore(
                                    getter,
                                    includeOverrides: !p.IsStatic,
                                    visiting,
                                    out var c
                                )
                                if c {
                                    hitCycle = true
                                }
                                summary.MergeFrom(
                                    ApplyReceiverAndMethodSubstitution(
                                        getterSummary,
                                        iface,
                                        getter,
                                        ImmutableArray[TypeSymbol].Empty
                                    )
                                )
                            } else {
                                let index = GetCompilationMethodsByName()
                                if index.TryGetValue("get_" + memberName, out var getters) {
                                    for g in getters {
                                        let gSummary = GetFunctionEffectSummaryCore(
                                            g,
                                            includeOverrides: false,
                                            visiting,
                                            out var c
                                        )
                                        if c {
                                            hitCycle = true
                                        }
                                        summary.MergeFrom(gSummary)
                                    }
                                }
                            }
                            return
                        }
                    }
                }
                return
            }
            default { }
        }
        let clr = stripped.ClrType ?? (stripped as ImportedTypeSymbol)?.OpenDefinition
        if clr == nil {
            return
        }
        let reflected = ReflectionType(clr)
        if reflected == nil {
            return
        }
        var cur Type? = reflected
        while cur != nil {
            for prop in ClrTypeUtilities.SafeGetProperties(
                cur,
                BindingFlags.Public |
                BindingFlags.NonPublic |
                BindingFlags.Instance |
                BindingFlags.Static |
                BindingFlags.DeclaredOnly
            ) {
                if prop.Name == memberName && prop.GetMethod != nil {
                    if !IsTrustedFrameworkAssembly(cur.Assembly) || !IsStableClrGetter(prop) {
                        summary.WritesAnyStorage = true
                    }
                    return
                }
            }
            cur = cur.BaseType
        }
    }

    private func ScanCalleeNamedCall(
        fnName string,
        typeArgList TypeArgumentListSyntax?,
        argTypes List[TypeSymbol?],
        origCallee FunctionSymbol,
        enclosingType TypeSymbol?,
        calleeTypeParams Dictionary[string, TypeParameterSymbol],
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        let methodTypeArgs = ResolveCalleeTypeArgumentList(typeArgList, calleeTypeParams)
        var found = false
        if enclosingType is StructSymbol s {
            let canHaveSubclass = s.IsClass && (s.IsOpen || s.IsAbstract || s.IsSealedHierarchy)
            for level in s.GetHierarchy() {
                for m in level.Methods {
                    if m.Name == fnName {
                        found = true
                        let incOverrides = canHaveSubclass || m.IsOpen || m.IsAbstract || m.IsOverride
                        let raw = GetFunctionEffectSummaryCore(m, incOverrides, visiting, out var c)
                        if c {
                            hitCycle = true
                        }
                        summary.MergeFrom(ApplyReceiverAndMethodSubstitution(raw, s, m, methodTypeArgs, argTypes))
                    }
                }
                for m in level.StaticMethods {
                    if m.Name == fnName {
                        found = true
                        let raw = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out var c)
                        if c {
                            hitCycle = true
                        }
                        summary.MergeFrom(ApplyReceiverAndMethodSubstitution(raw, s, m, methodTypeArgs, argTypes))
                    }
                }
            }
            if !found && s.GetHierarchy().Last().ImportedBaseType is {} impBase && !object.Equals(
                impBase,
                TypeSymbol.Object
            ) &&
                impBase.ClrType is {} impBaseClr &&
                ReflectionType(impBaseClr) is {} reflectedBase {
                try {
                    let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
                    for clrMem in reflectedBase.GetMember(fnName, flags) {
                        if clrMem is MethodInfo clrMethod {
                            found = true
                            summary.MergeFrom(
                                AnalyzeImportedMethodEffects(
                                    clrMethod,
                                    impBase,
                                    argTypes,
                                    default(ImmutableArray[TypeSymbol?]),
                                    includeOverrides: !clrMethod.IsStatic,
                                    visiting
                                )
                            )
                        }
                    }
                } catch (ex NotSupportedException) {
                    summary.WritesAnyStorage = true
                    return
                }
            }
        } else if enclosingType is InterfaceSymbol iface {
            for level in iface.SelfAndAllBaseInterfaces() {
                level.EnsureMembersResolved()
                for m in level.GetMethods(fnName) {
                    found = true
                    let raw = GetFunctionEffectSummaryCore(m, includeOverrides: true, visiting, out var c)
                    if c {
                        hitCycle = true
                    }
                    summary.MergeFrom(ApplyReceiverAndMethodSubstitution(raw, iface, m, methodTypeArgs))
                }
                for m in level.GetStaticMethods(fnName) {
                    found = true
                    let raw = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out var c)
                    if c {
                        hitCycle = true
                    }
                    summary.MergeFrom(ApplyReceiverAndMethodSubstitution(raw, iface, m, methodTypeArgs))
                }
            }
        }
        let scopeFns = $scope.TryLookupFunctions(fnName)
        if !scopeFns.IsDefaultOrEmpty {
            found = true
            for fn in scopeFns {
                let incOverrides = !fn.IsStatic &&
                    (fn.ReceiverType is InterfaceSymbol || fn.IsOpen || fn.IsAbstract || fn.IsOverride)
                let raw = GetFunctionEffectSummaryCore(fn, incOverrides, visiting, out var c)
                if c {
                    hitCycle = true
                }
                summary.MergeFrom(ApplyReceiverAndMethodSubstitution(raw, nil, fn, methodTypeArgs))
            }
        }
        for importedType in binderCtx.GetStaticImportTypes() {
            for m in importedType.StaticMethods {
                if m.Name == fnName {
                    found = true
                    let raw = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out var c)
                    if c {
                        hitCycle = true
                    }
                    summary.MergeFrom(ApplyReceiverAndMethodSubstitution(raw, importedType, m, methodTypeArgs))
                }
            }
        }
        for clrType in $scope.EnumerateStaticImportClrTypes() {
            if ReflectionType(clrType) is {} reflected {
                for clrMem in reflected.GetMember(
                    fnName,
                    BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy
                ) {
                    if clrMem is MethodInfo clrMethod {
                        found = true
                        summary.MergeFrom(
                            AnalyzeImportedMethodEffects(
                                clrMethod,
                                nil,
                                argTypes,
                                default(ImmutableArray[TypeSymbol?]),
                                includeOverrides: false,
                                visiting
                            )
                        )
                    }
                }
            }
        }
        if found {
            return
        }
        if fnName == "init" && enclosingType is StructSymbol selfCtorStruct {
            let origSelf = selfCtorStruct.Definition ?? selfCtorStruct
            for ctor in origSelf.EffectiveExplicitConstructors {
                let raw = GetFunctionEffectSummaryCore(ctor.Function, includeOverrides: false, visiting, out var c)
                if c {
                    hitCycle = true
                }
                summary.MergeFrom(
                    ApplyReceiverAndMethodSubstitution(
                        raw,
                        selfCtorStruct,
                        ctor.Function,
                        ImmutableArray[TypeSymbol].Empty
                    )
                )
            }
            return
        }
        if ResolveCalleeNamedType(fnName, typeArgList, calleeTypeParams) is {} constructedType {
            if constructedType is StructSymbol constructedStruct {
                ScanStructInstanceInitializers(constructedStruct, visiting, summary, ref hitCycle)
                for ctor in constructedStruct.EffectiveExplicitConstructors {
                    let raw = GetFunctionEffectSummaryCore(ctor.Function, includeOverrides: false, visiting, out var c)
                    if c {
                        hitCycle = true
                    }
                    summary.MergeFrom(
                        ApplyReceiverAndMethodSubstitution(
                            raw,
                            constructedStruct,
                            ctor.Function,
                            ImmutableArray[TypeSymbol].Empty
                        )
                    )
                }
            }
            return
        }
        let compIndex = GetCompilationMethodsByName()
        if compIndex.TryGetValue(fnName, out var compMethods) {
            var matchedFreeFn = false
            for cm in compMethods {
                if cm.ReceiverType != nil {
                    continue
                }
                if cm.Declaration == nil && cm.LocalDeclaration == nil && cm.AssociatedSymbol == nil {
                    continue
                }
                var minParams = 0
                for p in cm.Parameters {
                    if !p.HasExplicitDefaultValue && !p.IsVariadic {
                        minParams++
                    }
                }
                let hasVariadic = cm.Parameters.Length > 0 && cm.Parameters[cm.Parameters.Length - 1].IsVariadic
                if argTypes.Count < minParams || (!hasVariadic && argTypes.Count > cm.Parameters.Length) {
                    continue
                }
                matchedFreeFn = true
                let raw = GetFunctionEffectSummaryCore(cm, includeOverrides: false, visiting, out var c)
                if c {
                    hitCycle = true
                }
                summary.MergeFrom(ApplyReceiverAndMethodSubstitution(raw, nil, cm, methodTypeArgs))
            }
            if matchedFreeFn {
                return
            }
        }
        for s in binderCtx.RootScope.GetDeclaredStructs() {
            if s.Name == fnName {
                ScanStructInstanceInitializers(s, visiting, summary, ref hitCycle)
                for ctor in s.EffectiveExplicitConstructors {
                    let raw = GetFunctionEffectSummaryCore(ctor.Function, includeOverrides: false, visiting, out var c)
                    if c {
                        hitCycle = true
                    }
                    summary.MergeFrom(
                        ApplyReceiverAndMethodSubstitution(raw, s, ctor.Function, ImmutableArray[TypeSymbol].Empty)
                    )
                }
                return
            }
        }
        summary.WritesAnyStorage = true
    }

    private func CollectCalleeFreshLocals(body SyntaxNode, refLocalsFromParams HashSet[string]) {
        let candidates = HashSet[string](StringComparer.Ordinal)
        let nonFresh = HashSet[string](StringComparer.Ordinal)
        CollectCalleeFreshLocalsCore(body, candidates, nonFresh)
        for name in candidates {
            let sourceName = if name.StartsWith("#default:", StringComparison.Ordinal) {
                name.Substring(9)
            } else {
                name
            }
            if !nonFresh.Contains(sourceName) {
                refLocalsFromParams.Add("#fresh:" + name)
                if sourceName != name {
                    refLocalsFromParams.Add(name)
                }
            }
        }
    }

    private func CollectCalleeFreshLocalsCore(node SyntaxNode?, candidates HashSet[string], nonFresh HashSet[string]) {
        if node == nil {
            return
        }
        switch node {
            case FunctionDeclarationSyntax, FunctionLiteralExpressionSyntax, LambdaExpressionSyntax {
                return
            }
            case varDecl is VariableDeclarationSyntax {
                let name = varDecl.Identifier.ValueText
                if name.Length > 0 {
                    if !varDecl.HasRefKindModifier &&
                        (
                        varDecl.Initializer == nil ||
                            IsCalleeNilSyntax(varDecl.Initializer) ||
                            varDecl.Initializer is DefaultExpressionSyntax ||
                            IsCalleeFreshAllocationSyntax(varDecl.Initializer)
                    ) {
                        candidates.Add(name)
                        if varDecl
                            .Keyword
                            ?.Kind == SyntaxKind.LetKeyword &&
                            IsDefaultCallbackConstructionSyntax(varDecl.Initializer) {
                            candidates.Add("#default:" + name)
                        }
                    } else {
                        nonFresh.Add(name)
                    }
                }
            }
            case assign is AssignmentExpressionSyntax {
                if !IsCalleeNilSyntax(assign.Expression) &&
                    assign.Expression !is DefaultExpressionSyntax &&
                    !IsCalleeFreshAllocationSyntax(assign.Expression) {
                    nonFresh.Add(assign.IdentifierToken.ValueText)
                }
            }
            case nca is NullCoalescingAssignmentExpressionSyntax {
                if nca.Target is NameExpressionSyntax ncaName {
                    if !IsCalleeFreshAllocationSyntax(nca.Value) {
                        nonFresh.Add(ncaName.IdentifierToken.ValueText)
                    }
                }
            }
            case refArg is RefArgumentExpressionSyntax {
                if UnwrapRefTargetName(refArg.Expression) is {} rName {
                    nonFresh.Add(rName)
                }
            }
            case unary is UnaryExpressionSyntax when unary.OperatorToken.Kind == SyntaxKind.AmpersandToken {
                if UnwrapRefTargetName(unary.Operand) is {} uName {
                    nonFresh.Add(uName)
                }
            }
            default { }
        }
        for child in node.GetChildren() {
            CollectCalleeFreshLocalsCore(child, candidates, nonFresh)
        }
    }

    private func IsCalleeFreshLocalExpression(expr ExpressionSyntax?, refLocalsFromParams HashSet[string]) bool {
        var cur = expr
        while cur is ParenthesizedExpressionSyntax paren {
            cur = paren.Expression
        }
        while cur is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.BangBangToken}} bang {
            cur = bang.Operand
            while cur is ParenthesizedExpressionSyntax paren2 {
                cur = paren2.Expression
            }
        }
        if cur is NameExpressionSyntax nameExpr {
            return refLocalsFromParams.Contains("#fresh:" + nameExpr.IdentifierToken.ValueText)
        }
        return IsCalleeFreshAllocationSyntax(cur)
    }

    private func IsCalleeFreshAllocationSyntax(expr ExpressionSyntax?) bool {
        var cur = expr
        while cur is ParenthesizedExpressionSyntax paren {
            cur = paren.Expression
        }
        while cur is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.BangBangToken}} bang {
            cur = bang.Operand
            while cur is ParenthesizedExpressionSyntax paren2 {
                cur = paren2.Expression
            }
        }
        switch cur {
            case nil {
                return false
            }
            case ArrayCreationExpressionSyntax, ObjectCreationExpressionSyntax, StructLiteralExpressionSyntax {
                return true
            }
            case call is CallExpressionSyntax {
                if call.Callee == nil && call.ConversionTypeClause == nil {
                    let fnName = call.Identifier.ValueText
                    if (
                        fnName is "List" or
                            "HashSet" or
                            "Dictionary" or
                            "Queue" or
                            "Stack" or
                            "ConcurrentDictionary" or
                            "StringBuilder"
                    ) &&
                        $scope
                        .TryLookupFunctions(fnName).IsDefaultOrEmpty {
                        return true
                    }
                    if LookupCompilationTypeByName(
                        fnName,
                        call.TypeArgumentList?.Arguments.Count ?? 0
                    ) is {} namedType &&
                        namedType != TypeSymbol.Error {
                        return true
                    }
                }
                return false
            }
            case acc is AccessorExpressionSyntax {
                if acc.LeftPart is NameExpressionSyntax leftId &&
                    (
                    leftId.IdentifierToken.ValueText is "ImmutableArray" or "ImmutableDictionary" or "ImmutableHashSet"
                ) &&
                    $scope.TryLookupSymbol(leftId.IdentifierToken.ValueText) == nil &&
                    LookupCompilationTypeByName(leftId.IdentifierToken.ValueText, 0) == nil &&
                    acc.RightPart is CallExpressionSyntax rightCall &&
                    rightCall
                    .Identifier
                    .ValueText == "CreateBuilder" {
                    return true
                }
                return false
            }
            case bin is BinaryExpressionSyntax when bin.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken {
                return IsCalleeFreshAllocationSyntax(bin.Left) && IsCalleeFreshAllocationSyntax(bin.Right)
            }
            case ifExpr is IfExpressionSyntax {
                return IsCalleeFreshAllocationSyntax(ifExpr.ThenBlock) &&
                    (ifExpr.ElseExpression == nil || IsCalleeFreshAllocationSyntax(ifExpr.ElseExpression))
            }
            case blk is BlockExpressionSyntax {
                return IsCalleeFreshAllocationSyntax(blk.Expression)
            }
            default {
                return false
            }
        }
    }

    private func ScanCalleeMemberCall(
        receiverType TypeSymbol,
        memberName string,
        isStatic bool,
        typeArgList TypeArgumentListSyntax?,
        argTypes List[TypeSymbol?],
        calleeTypeParams Dictionary[string, TypeParameterSymbol],
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool,
        allowUnresolvedFallback bool = true,
        receiverIsFreshLocal bool = false,
        receiverHasDefaultComparer bool = false,
        exactEnumeration bool = false
    ) {
        let methodTypeArgs = ResolveCalleeTypeArgumentList(typeArgList, calleeTypeParams)
        let stripped = StripAllNullability(receiverType) ?? receiverType
        var matched = false
        var clrType Type? = nil
        var symbolic TypeSymbol? = stripped
        switch stripped {
            case s is StructSymbol {
                let canHaveSubclass = s.IsClass && (s.IsOpen || s.IsAbstract || s.IsSealedHierarchy)
                for level in s.GetHierarchy() {
                    let methods = if isStatic {
                        level.StaticMethods
                    } else {
                        level.Methods
                    }
                    for m in methods {
                        if m.Name == memberName {
                            matched = true
                            let incOverrides = !isStatic &&
                                (canHaveSubclass || m.IsOpen || m.IsAbstract || m.IsOverride)
                            let raw = GetFunctionEffectSummaryCore(m, incOverrides, visiting, out var c)
                            if c {
                                hitCycle = true
                            }
                            summary.MergeFrom(ApplyReceiverAndMethodSubstitution(raw, s, m, methodTypeArgs))
                        }
                    }
                }
                if !matched {
                    if s.GetHierarchy().Last().ImportedBaseType is {} impBase {
                        clrType = (impBase as ImportedTypeSymbol)?.OpenDefinition ?? impBase.ClrType ?? typeof(object)
                        symbolic = s
                    } else {
                        clrType = typeof(object)
                    }
                }
            }
            case iface is InterfaceSymbol {
                for level in iface.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    let methods = if isStatic {
                        level.GetStaticMethods(memberName)
                    } else {
                        level.GetMethods(memberName)
                    }
                    for m in methods {
                        matched = true
                        let raw = GetFunctionEffectSummaryCore(m, includeOverrides: !isStatic, visiting, out var c)
                        if c {
                            hitCycle = true
                        }
                        summary.MergeFrom(ApplyReceiverAndMethodSubstitution(raw, iface, m, methodTypeArgs))
                    }
                    for clrBase in level.BaseClrInterfaces {
                        ScanCalleeMemberCall(
                            clrBase,
                            memberName,
                            isStatic,
                            typeArgList,
                            argTypes,
                            calleeTypeParams,
                            visiting,
                            summary,
                            ref hitCycle,
                            allowUnresolvedFallback: false
                        )
                        matched = true
                    }
                }
                if !matched {
                    clrType = typeof(object)
                }
            }
            case tp is TypeParameterSymbol {
                let seenTp = HashSet[TypeParameterSymbol]()
                var cur TypeParameterSymbol? = tp
                while cur != nil && seenTp.Add(cur) {
                    if cur.InterfaceConstraint is {} ic {
                        ScanCalleeMemberCall(
                            ic,
                            memberName,
                            isStatic,
                            typeArgList,
                            argTypes,
                            calleeTypeParams,
                            visiting,
                            summary,
                            ref hitCycle,
                            allowUnresolvedFallback: false
                        )
                        matched = true
                    }
                    if cur.ClrInterfaceConstraint is {} cic {
                        ScanCalleeMemberCall(
                            cic,
                            memberName,
                            isStatic,
                            typeArgList,
                            argTypes,
                            calleeTypeParams,
                            visiting,
                            summary,
                            ref hitCycle,
                            allowUnresolvedFallback: false
                        )
                        matched = true
                    }
                    if cur.ClassConstraint is {} cc {
                        ScanCalleeMemberCall(
                            cc,
                            memberName,
                            isStatic,
                            typeArgList,
                            argTypes,
                            calleeTypeParams,
                            visiting,
                            summary,
                            ref hitCycle,
                            allowUnresolvedFallback: false
                        )
                        matched = true
                    }
                    cur = cur.TypeParameterBound
                }
                clrType = typeof(object)
            }
            case EnumSymbol {
                clrType = typeof(Enum)
                symbolic = stripped
            }
            case imp is ImportedTypeSymbol {
                clrType = imp.OpenDefinition ?? imp.ClrType
                symbolic = imp
            }
            default {
                clrType = stripped.ClrType
                symbolic = stripped
            }
        }
        if clrType != nil && ReflectionType(clrType) is {} reflected {
            try {
                let searched = List[Type]()
                searched.Add(reflected)
                if reflected.IsInterface {
                    searched.AddRange(reflected.GetInterfaces())
                    searched.Add(typeof(object))
                }
                let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
                for searchedType in searched {
                    for clrMem in searchedType.GetMember(memberName, flags) {
                        if clrMem is MethodInfo clrMethod && clrMethod.IsStatic == isStatic {
                            let clrParams = clrMethod.GetParameters()
                            var minClrParams = 0
                            for cp in clrParams {
                                if !cp.IsOptional && !ClrOverloadResolution.IsParamsArrayParameter(cp) {
                                    minClrParams++
                                }
                            }
                            let hasClrParams = clrParams.Length > 0 &&
                                (
                                clrParams[clrParams.Length - 1]
                                    .ParameterType
                                    .IsArray ||
                                    ClrOverloadResolution.IsParamsArrayParameter(clrParams[clrParams.Length - 1])
                            )
                            if argTypes.Count < minClrParams || (!hasClrParams && argTypes.Count > clrParams.Length) {
                                continue
                            }
                            if isStatic && object.Equals(stripped, TypeSymbol.String) &&
                                clrMethod
                                .DeclaringType
                                ?.FullName == "System.Object" {
                                continue
                            }
                            matched = true
                            summary.MergeFrom(
                                AnalyzeImportedMethodEffects(
                                    clrMethod,
                                    symbolic,
                                    argTypes,
                                    methodTypeArgs.Select((type TypeSymbol) -> cast[TypeSymbol?](type))
                                        .ToImmutableArray(),
                                    includeOverrides: !isStatic,
                                    visiting,
                                    receiverIsFreshLocal: receiverIsFreshLocal,
                                    receiverHasDefaultComparer: receiverHasDefaultComparer,
                                    exactEnumeration: exactEnumeration
                                )
                            )
                        }
                    }
                }
            } catch (ex NotSupportedException) {
                summary.WritesAnyStorage = true
                return
            }
        }
        if !isStatic {
            let extFns = $scope.TryLookupExtensionFunctions(stripped, memberName)
            if !extFns.IsDefaultOrEmpty {
                matched = true
                for extFn in extFns {
                    let raw = GetFunctionEffectSummaryCore(extFn, includeOverrides: false, visiting, out var c)
                    if c {
                        hitCycle = true
                    }
                    summary.MergeFrom(ApplyReceiverAndMethodSubstitution(raw, stripped, extFn, methodTypeArgs))
                }
            } else if !matched {
                let impExts = MemberLookup(binderCtx).CollectImportedExtensionMethods(memberName)
                for impExt in impExts {
                    let extParams = impExt.GetParameters()
                    var minExtParams = 0
                    for ep in extParams {
                        if !ep.IsOptional && !ClrOverloadResolution.IsParamsArrayParameter(ep) {
                            minExtParams++
                        }
                    }
                    let hasExtParams = extParams.Length > 0 &&
                        (
                        extParams[extParams.Length - 1]
                            .ParameterType
                            .IsArray ||
                            ClrOverloadResolution.IsParamsArrayParameter(extParams[extParams.Length - 1])
                    )
                    if argTypes.Count + 1 < minExtParams || (!hasExtParams && argTypes.Count + 1 > extParams.Length) {
                        continue
                    }
                    matched = true
                    summary.MergeFrom(
                        AnalyzeImportedMethodEffects(
                            impExt,
                            stripped,
                            argTypes,
                            default(ImmutableArray[TypeSymbol?]),
                            includeOverrides: false,
                            visiting
                        )
                    )
                }
            }
        }
        if !matched && allowUnresolvedFallback {
            ScanCalleeUnresolvedMemberCall(memberName, argTypes, visiting, summary, ref hitCycle)
        }
    }

    private func IsKnownEffectFreeCollectionSyntax(expr ExpressionSyntax?) bool {
        var cur = expr
        while cur is ParenthesizedExpressionSyntax paren {
            cur = paren.Expression
        }
        if cur is AccessorExpressionSyntax acc {
            SplitRightmostMemberAccess(acc, out _, out var rightmost)
            if rightmost is CallExpressionSyntax rightCall {
                let mName = rightCall.Identifier.ValueText
                if mName is "ToArray" or
                    "ToList" or
                    "AsSpan" or
                    "GetGenericArguments" or
                    "GetParameters" or
                    "GetFields" or
                    "GetProperties" or
                    "GetMethods" or
                    "GetMembers" or
                    "GetInterfaces" or
                    "GetCustomAttributes" or
                    "GetCustomAttributesData" {
                    return true
                }
            }
        }
        return false
    }

    private func ScanCalleeForEachIteratorEffects(
        collType TypeSymbol?,
        calleeTypeParams Dictionary[string, TypeParameterSymbol],
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        let stripped = StripAllNullability(collType) ?? collType
        if stripped is StructSymbol collStruct &&
            !(collStruct.IsClass && (collStruct.IsOpen || collStruct.IsAbstract || collStruct.IsSealedHierarchy)) {
            let emptyArgs = List[TypeSymbol?]()
            ScanCalleeMemberCall(
                collStruct,
                "GetEnumerator",
                false,
                nil,
                emptyArgs,
                calleeTypeParams,
                visiting,
                summary,
                ref hitCycle
            )
            if GetMethodReturnTypeOnType(collStruct, "GetEnumerator", emptyArgs) is {} enumType {
                ScanCalleeMemberCall(
                    enumType,
                    "MoveNext",
                    false,
                    nil,
                    emptyArgs,
                    calleeTypeParams,
                    visiting,
                    summary,
                    ref hitCycle
                )
                RecordCalleeMemberReadEffects(enumType, "Current", false, visiting, summary, ref hitCycle)
                return
            }
        }
        MergeIteratorCallbackEffects(visiting, summary, ref hitCycle)
    }

    private func MergeIteratorCallbackEffects(
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool,
        includeCountGetter bool = false
    ) {
        let index = GetCompilationMethodsByName()
        let iterNames = if includeCountGetter {
            []string{"GetEnumerator", "MoveNext", "get_Current", "get_Count"}
        } else {
            []string{"GetEnumerator", "MoveNext", "get_Current"}
        }
        for name in iterNames {
            if index.TryGetValue(name, out var methods) {
                for m in methods {
                    if m.IsStatic || m.Parameters.Length != 0 {
                        continue
                    }
                    if name == "get_Count" {
                        if (m.AssociatedSymbol as PropertySymbol)?.IsAutoProperty == true {
                            continue
                        }
                    } else if name is "MoveNext" or "get_Current" {
                        if (m.ReceiverType as StructSymbol) is not{} owner || !owner.Properties.Any(
                            (p PropertySymbol) -> p.Name == "Current"
                        ) {
                            continue
                        }
                    }
                    let s = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out var c)
                    if c {
                        hitCycle = true
                    }
                    summary.MergeFrom(s)
                    if summary.WritesAnyStorage {
                        return
                    }
                }
            }
        }
    }

    private func ScanCalleeUnresolvedMemberCall(
        memberName string,
        argTypes List[TypeSymbol?],
        visiting HashSet[FunctionSymbol],
        summary CallEffectSummary,
        ref hitCycle bool
    ) {
        if InvokesDelegate(memberName) {
            summary.WritesAnyStorage = true
            return
        }
        for s in binderCtx.RootScope.GetDeclaredStructs() {
            for f in s.Fields {
                if f.Name == memberName && IsCallableMemberType(f.Type) {
                    summary.WritesAnyStorage = true
                    return
                }
            }
            for p in s.Properties {
                if p.Name == memberName && IsCallableMemberType(p.Type) {
                    summary.WritesAnyStorage = true
                    return
                }
            }
        }
        for iface in binderCtx.RootScope.GetDeclaredInterfaces() {
            iface.EnsureMembersResolved()
            for p in iface.Properties {
                if p.Name == memberName && IsCallableMemberType(p.Type) {
                    summary.WritesAnyStorage = true
                    return
                }
            }
        }
        let index = GetCompilationMethodsByName()
        if index.TryGetValue(memberName, out var methods) {
            for m in methods {
                if m.Declaration == nil && m.LocalDeclaration == nil && m.AssociatedSymbol == nil {
                    continue
                }
                var minParams = 0
                for p in m.Parameters {
                    if !p.HasExplicitDefaultValue && !p.IsVariadic {
                        minParams++
                    }
                }
                let hasVariadic = m.Parameters.Length > 0 && m.Parameters[m.Parameters.Length - 1].IsVariadic
                if argTypes.Count < minParams || (!hasVariadic && argTypes.Count > m.Parameters.Length) {
                    continue
                }
                var argsCompatible = true
                let checkCount = Math.Min(argTypes.Count, m.Parameters.Length)
                for var i = 0; i < checkCount; i++ {
                    let param = m.Parameters[i]
                    if param.IsVariadic {
                        break
                    }
                    if argTypes[i] is {} knownArgType &&
                        !WrittenLocationMayHoldRoot(param.Type, knownArgType, isElement: false) &&
                        !WrittenLocationMayHoldRoot(knownArgType, param.Type, isElement: false) {
                        argsCompatible = false
                        break
                    }
                }
                if !argsCompatible {
                    continue
                }
                if (memberName is "Equals" or "GetHashCode" or "CompareTo" or "Compare") && m.IsStatic {
                    continue
                }
                let s = GetFunctionEffectSummaryCore(m, includeOverrides: false, visiting, out var c)
                if c {
                    hitCycle = true
                }
                summary.MergeFrom(s)
                if summary.WritesAnyStorage {
                    return
                }
            }
        }
        if memberName.StartsWith("SetValue", StringComparison.Ordinal) ||
            memberName is "Invoke" or
            "InvokeMember" or
            "DynamicInvoke" or
            "Write" or
            "WriteUnaligned" or
            "CopyBlock" or
            "InitBlock" {
            summary.WritesAnyStorage = true
            return
        }
        if MayInvokeEqualityOrComparerCallback("", memberName) {
            MergeEqualityOrComparerCallbackEffects("", memberName, nil, argTypes, visiting, summary)
        }
        if MayInvokeToStringCallback("", memberName) {
            MergeToStringCallbackEffects(memberName, nil, argTypes, visiting, summary)
        }
        if !IsDeferredLinqOperatorName(memberName) && argTypes.Any((a TypeSymbol?) -> IsLazyEnumerableType(a)) &&
            (
            visiting.Count == 0 || CompilationHasGlobalOrStaticEnumerable() || VisitingChainAcceptsEnumerable(visiting)
        ) {
            MergeDeferredEnumerableCallbackEffects(visiting, summary)
        }
        for argType in argTypes {
            if argType != nil && TryGetMutableBufferElementType(argType) is {} elemType {
                summary.AddElementType(elemType)
            }
        }
    }

    private func IsCallableMemberType(type TypeSymbol?) bool {
        let stripped = StripAllNullability(type) ?? type
        if stripped is FunctionTypeSymbol or DelegateTypeSymbol {
            return true
        }
        return stripped?.ClrType is {} clr && ClrTypeUtilities.IsDelegateType(clr)
    }

    private func ResolveCalleeTypeArgumentList(
        typeArgList TypeArgumentListSyntax?,
        calleeTypeParams Dictionary[string, TypeParameterSymbol]
    ) ImmutableArray[TypeSymbol] {
        if typeArgList == nil || typeArgList.Arguments.Count == 0 {
            return ImmutableArray[TypeSymbol].Empty
        }
        let builder = ImmutableArray.CreateBuilder[TypeSymbol](typeArgList.Arguments.Count)
        for argSyntax in typeArgList.Arguments {
            if ResolveCalleeTypeClause(argSyntax, calleeTypeParams) is {} resolved {
                builder.Add(resolved)
            } else {
                return ImmutableArray[TypeSymbol].Empty
            }
        }
        return builder.MoveToImmutable()
    }

    private func ResolveCalleeTypeClause(
        clause TypeClauseSyntax?,
        calleeTypeParams Dictionary[string, TypeParameterSymbol]?
    ) TypeSymbol? {
        if clause == nil {
            return nil
        }
        if clause.IsArray && clause.HasNestedArrayElement {
            guard let nestedElem = ResolveCalleeTypeClause(clause.ArrayElementType, calleeTypeParams) else {
                return nil
            }
            return WrapCalleeArraySuffix(clause, nestedElem)
        }
        if clause.IsTuple && clause.TupleElements is {} tupleElements {
            let elemBuilder = ImmutableArray.CreateBuilder[TypeSymbol](tupleElements.Count)
            for elem in tupleElements {
                guard let resolvedElem = ResolveCalleeTypeClause(elem, calleeTypeParams) else {
                    return nil
                }
                elemBuilder.Add(resolvedElem)
            }
            let tupleType = TupleTypeSymbol.Get(elemBuilder.MoveToImmutable())
            return if clause.QuestionToken != nil {
                NullableTypeSymbol.Get(tupleType)
            } else {
                tupleType
            }
        }
        if clause.IsMap {
            guard let kType = ResolveCalleeTypeClause(clause.MapKeyType, calleeTypeParams),
            let vType = ResolveCalleeTypeClause(clause.MapValueType, calleeTypeParams) else {
                return nil
            }
            let mType = MapTypeSymbol.Get(kType, vType)
            return if clause.QuestionToken != nil {
                NullableTypeSymbol.Get(mType)
            } else {
                mType
            }
        }
        if clause.Identifier == nil {
            return nil
        }
        let dotted = clause.DottedName
        let arity = clause.TypeArguments?.Count ?? 0
        var resolvedBase TypeSymbol? = nil
        if arity == 0 {
            if calleeTypeParams != nil && calleeTypeParams.TryGetValue(dotted, out var tp) {
                resolvedBase = tp
            } else if binderCtx.CurrentTypeParameters?.TryGetValue(dotted, out var encTp) == true {
                resolvedBase = encTp
            }
        }
        if resolvedBase == nil {
            let baseType = LookupCompilationTypeByName(dotted, arity) ?? ResolveTestedType(dotted, arity)
            if baseType == nil {
                return nil
            }
            resolvedBase = ConstructTypeWithClauseArguments(baseType, clause, calleeTypeParams) ?? baseType
        }
        if clause.IsArray {
            return WrapCalleeArraySuffix(clause, resolvedBase)
        }
        return if clause.QuestionToken != nil {
            NullableTypeSymbol.Get(resolvedBase)
        } else {
            resolvedBase
        }
    }

    private func WrapCalleeArraySuffix(clause TypeClauseSyntax, element TypeSymbol) TypeSymbol? {
        var elem = element
        if clause.IsNullable {
            elem = NullableTypeSymbol.Get(elem)
        }
        if clause.IsSlice {
            return SliceTypeSymbol.Get(elem)
        }
        if clause.RectangularRank > 1 {
            return RectangularArrayTypeSymbol.Get(elem, clause.RectangularRank)
        }
        if clause.LengthToken is {} lenTok && int32.TryParse(lenTok.Text, out var len) && len >= 0 {
            return ArrayTypeSymbol.Get(elem, len)
        }
        return SliceTypeSymbol.Get(elem)
    }

    private func ResolveCalleeNamedType(
        name string,
        typeArgList TypeArgumentListSyntax?,
        calleeTypeParams Dictionary[string, TypeParameterSymbol]?
    ) TypeSymbol? {
        let arity = typeArgList?.Arguments.Count ?? 0
        if arity == 0 && calleeTypeParams != nil && calleeTypeParams.TryGetValue(name, out var tp) {
            return tp
        }
        let baseType = LookupCompilationTypeByName(name, arity) ?? ResolveTestedType(name, arity)
        if baseType == nil {
            return nil
        }
        if arity == 0 || typeArgList == nil {
            return baseType
        }
        let typeArgs = ImmutableArray.CreateBuilder[TypeSymbol](arity)
        for argSyntax in typeArgList.Arguments {
            guard let resolvedArg = ResolveCalleeTypeClause(argSyntax, calleeTypeParams) else {
                return baseType
            }
            typeArgs.Add(resolvedArg)
        }
        let args = typeArgs.MoveToImmutable()
        if baseType is StructSymbol s {
            let def = s.Definition ?? s
            if def.TypeParameters.Length == args.Length {
                return StructSymbol.Construct(def, args)
            }
        }
        if baseType is InterfaceSymbol iface {
            let def = iface.Definition ?? iface
            if def.TypeParameters.Length == args.Length {
                return InterfaceSymbol.Construct(def, args)
            }
        }
        if baseType.ClrType is {} clr {
            let openClr = if clr.IsGenericTypeDefinition {
                clr
            } else if clr.IsGenericType {
                clr.GetGenericTypeDefinition()
            } else {
                default(Type?)
            }
            if openClr != nil && openClr.GetGenericArguments().Length == args.Length {
                return ImportedTypeSymbol.GetConstructed(openClr, openClr, args)
            }
        }
        return baseType
    }

    private func LookupCompilationTypeByName(name string, arity int32) TypeSymbol? {
        let lastDot = name.LastIndexOf('.')
        let pkgQualifier string? = if lastDot >= 0 {
            name.Substring(0, lastDot)
        } else {
            default(string?)
        }
        let simpleName = if lastDot >= 0 {
            name.Substring(lastDot + 1)
        } else {
            name
        }
        var anyMatch TypeSymbol? = nil
        var matchCount = 0
        for s in binderCtx.RootScope.GetDeclaredStructs() {
            let def = s.Definition ?? s
            if def.Name == simpleName && def.TypeParameters.Length == arity {
                let defPkg string = def.PackageName ?? ""
                if pkgQualifier is {} pkg {
                    if defPkg == pkg {
                        matchCount++
                        anyMatch = def
                    }
                    continue
                }
                matchCount++
                anyMatch = def
            }
        }
        for iface in binderCtx.RootScope.GetDeclaredInterfaces() {
            let def = iface.Definition ?? iface
            if def.Name == simpleName && def.TypeParameters.Length == arity {
                let defPkg string = def.PackageName ?? ""
                if pkgQualifier is {} pkg {
                    if defPkg == pkg {
                        matchCount++
                        anyMatch = def
                    }
                    continue
                }
                matchCount++
                anyMatch = def
            }
        }
        if matchCount == 1 {
            return anyMatch
        }
        if matchCount > 1 {
            // An ambiguous source name must not fall through to lookup in the caller's scope.
            return TypeSymbol.Error
        }
        return nil
    }

    private func InferCalleeNameOrType(
        name string,
        origCallee FunctionSymbol,
        enclosingType TypeSymbol?,
        parameters Dictionary[string, ParameterSymbol],
        calleeTypeParams Dictionary[string, TypeParameterSymbol],
        localTypes Dictionary[string, TypeSymbol?],
        out isTypeReceiver bool
    ) TypeSymbol? {
        isTypeReceiver = false
        if name == "this" {
            return enclosingType
        }
        if localTypes.TryGetValue(name, out var localType) {
            return localType
        }
        if parameters.TryGetValue(name, out var param) {
            return param.Type
        }
        if enclosingType is StructSymbol s {
            for level in s.GetHierarchy() {
                for f in level.Fields {
                    if f.Name == name {
                        return s.SubstituteMemberType(f.Type) ?? level.SubstituteMemberType(f.Type) ?? f.Type
                    }
                }
                for sf in level.StaticFields {
                    if sf.Name == name {
                        return s.SubstituteMemberType(sf.Type) ?? level.SubstituteMemberType(sf.Type) ?? sf.Type
                    }
                }
                for p in level.Properties {
                    if p.Name == name && !p.IsIndexer {
                        return s.SubstituteMemberType(p.Type) ?? level.SubstituteMemberType(p.Type) ?? p.Type
                    }
                }
                for sp in level.StaticProperties {
                    if sp.Name == name && !sp.IsIndexer {
                        return s.SubstituteMemberType(sp.Type) ?? level.SubstituteMemberType(sp.Type) ?? sp.Type
                    }
                }
            }
            if s.GetHierarchy().Last().ImportedBaseType is {} impBase {
                if GetMemberTypeOnType(impBase, name) is {} baseMemType {
                    return baseMemType
                }
            }
        } else if enclosingType is InterfaceSymbol iface {
            for level in iface.SelfAndAllBaseInterfaces() {
                level.EnsureMembersResolved()
                for p in level.Properties {
                    if p.Name == name && !p.IsIndexer {
                        return iface.SubstituteMemberType(level.SubstituteMemberType(p.Type))
                    }
                }
            }
        }
        if $scope.TryLookupSymbol(name) is {} sym {
            if sym is VariableSymbol v {
                return v.Type
            }
            if sym is TypeSymbol t {
                isTypeReceiver = true
                return t
            }
        }
        if TryResolveBareFallbackMember(name, out var fallbackType, out _, out _, out _) && fallbackType != nil {
            return fallbackType
        }
        if ResolveCalleeNamedType(name, nil, calleeTypeParams) is {} namedType {
            isTypeReceiver = true
            return namedType
        }
        return nil
    }

    private func InferCalleeExpressionType(
        expr ExpressionSyntax?,
        origCallee FunctionSymbol,
        enclosingType TypeSymbol?,
        parameters Dictionary[string, ParameterSymbol],
        calleeTypeParams Dictionary[string, TypeParameterSymbol],
        localTypes Dictionary[string, TypeSymbol?],
        out isTypeReceiver bool
    ) TypeSymbol? {
        isTypeReceiver = false
        switch expr {
            case nil {
                return nil
            }
            case paren is ParenthesizedExpressionSyntax {
                return InferCalleeExpressionType(
                    paren.Expression,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out isTypeReceiver
                )
            }
            case refArg is RefArgumentExpressionSyntax {
                return InferCalleeExpressionType(
                    refArg.Expression,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out isTypeReceiver
                )
            }
            case unary is UnaryExpressionSyntax {
                if unary.OperatorToken.Kind == SyntaxKind.BangBangToken {
                    let opType = InferCalleeExpressionType(
                        unary.Operand,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    )
                    return if opType is NullableTypeSymbol n {
                        n.UnderlyingType
                    } else {
                        opType
                    }
                }
                if unary.OperatorToken.Kind == SyntaxKind.AmpersandToken {
                    return InferCalleeExpressionType(
                        unary.Operand,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    )
                }
                let uOpType = InferCalleeExpressionType(
                    unary.Operand,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                let sUOp = StripAllNullability(uOpType) ?? uOpType
                if OperatorNames.TryGetUnaryName(unary.OperatorToken.Kind) is {} uOpName {
                    if sUOp is StructSymbol uStruct {
                        for sm in uStruct.StaticMethods {
                            if sm.Name == uOpName {
                                return sm.Type
                            }
                        }
                    }
                    if sUOp != nil {
                        for extFn in $scope.TryLookupExtensionFunctions(sUOp, uOpName) {
                            return extFn.Type
                        }
                    }
                }
                if unary.OperatorToken.Kind == SyntaxKind.BangToken && object.Equals(sUOp, TypeSymbol.Bool) {
                    return TypeSymbol.Bool
                }
                if sUOp != nil && TypeSymbol.IsLegalPointeeType(sUOp) {
                    return sUOp
                }
                return nil
            }
            case IsExpressionSyntax {
                return TypeSymbol.Bool
            }
            case nameExpr is NameExpressionSyntax {
                return InferCalleeNameOrType(
                    nameExpr.IdentifierToken.ValueText,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out isTypeReceiver
                )
            }
            case InterpolatedStringExpressionSyntax, NameOfExpressionSyntax {
                return TypeSymbol.String
            }
            case TypeOfExpressionSyntax {
                return TypeSymbol.FromClrTypeWithoutNullability(typeof(Type), NullabilityFreeReason.TypeLiteral)
            }
            case SizeOfExpressionSyntax {
                return TypeSymbol.Int32
            }
            case lit is LiteralExpressionSyntax {
                if lit.LiteralToken.Kind == SyntaxKind.StringToken {
                    return TypeSymbol.String
                }
                if lit.LiteralToken.Kind == SyntaxKind.CharacterToken || lit.Value is char {
                    return TypeSymbol.Char
                }
                if lit.LiteralToken.Kind == SyntaxKind.TrueKeyword || lit.LiteralToken.Kind == SyntaxKind.FalseKeyword {
                    return TypeSymbol.Bool
                }
                switch lit.Value {
                    case int32 {
                        return TypeSymbol.Int32
                    }
                    case int64 {
                        return TypeSymbol.Int64
                    }
                    case uint32 {
                        return TypeSymbol.UInt32
                    }
                    case uint64 {
                        return TypeSymbol.UInt64
                    }
                    case uint8 {
                        return TypeSymbol.UInt8
                    }
                    case int8 {
                        return TypeSymbol.Int8
                    }
                    case int16 {
                        return TypeSymbol.Int16
                    }
                    case uint16 {
                        return TypeSymbol.UInt16
                    }
                    case float64 {
                        return TypeSymbol.Float64
                    }
                    case float32 {
                        return TypeSymbol.Float32
                    }
                    case decimal {
                        return TypeSymbol.Decimal
                    }
                    default {
                        return nil
                    }
                }
            }
            case defExpr is DefaultExpressionSyntax {
                return ResolveCalleeTypeClause(defExpr.TypeClause, calleeTypeParams)
            }
            case arrCreate is ArrayCreationExpressionSyntax {
                let elemType = if arrCreate.ElementTypeClause != nil {
                    ResolveCalleeTypeClause(arrCreate.ElementTypeClause, calleeTypeParams)
                } else if arrCreate.ElementTypeIdentifier is {} elemId {
                    ResolveCalleeNamedType(elemId.ValueText, nil, calleeTypeParams)
                } else {
                    default(TypeSymbol?)
                }
                return if elemType != nil {
                    cast[TypeSymbol](SliceTypeSymbol.Get(elemType))
                } else {
                    default(TypeSymbol?)
                }
            }
            case objCreate is ObjectCreationExpressionSyntax {
                return InferCalleeExpressionType(
                    objCreate.Target,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
            }
            case structLit is StructLiteralExpressionSyntax {
                return ResolveCalleeNamedType(
                    structLit.TypeIdentifier.ValueText,
                    structLit.TypeArgumentList,
                    calleeTypeParams
                )
            }
            case asExpr is AsExpressionSyntax {
                return ResolveCalleeTypeClause(asExpr.TypeClause, calleeTypeParams)
            }
            case bin is BinaryExpressionSyntax {
                let bKind = bin.OperatorToken.Kind
                if bKind == SyntaxKind.QuestionQuestionToken {
                    return InferCalleeExpressionType(
                        bin.Left,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    ) ??
                        InferCalleeExpressionType(
                        bin.Right,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    )
                }
                if bKind is SyntaxKind.AmpersandAmpersandToken or SyntaxKind.PipePipeToken {
                    return TypeSymbol.Bool
                }
                let leftType = InferCalleeExpressionType(
                    bin.Left,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                let rightType = InferCalleeExpressionType(
                    bin.Right,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                let sLeft = StripAllNullability(leftType) ?? leftType
                let sRight = StripAllNullability(rightType) ?? rightType
                if OperatorNames.TryGetBinaryName(bKind) is {} bOpName {
                    let candidates = List[TypeSymbol?]{sLeft, sRight}
                    for cand in candidates {
                        if cand is StructSymbol opStruct {
                            for sm in opStruct.StaticMethods {
                                if sm.Name == bOpName {
                                    return sm.Type
                                }
                            }
                        }
                        if cand != nil {
                            for extFn in $scope.TryLookupExtensionFunctions(cand, bOpName) {
                                return extFn.Type
                            }
                        }
                    }
                }
                if bKind is SyntaxKind.EqualsEqualsToken or
                    SyntaxKind.BangEqualsToken or
                    SyntaxKind.LessToken or
                    SyntaxKind.LessOrEqualsToken or
                    SyntaxKind.GreaterToken or
                    SyntaxKind.GreaterOrEqualsToken {
                    return TypeSymbol.Bool
                }
                if bKind == SyntaxKind.PlusToken &&
                    (object.Equals(sLeft, TypeSymbol.String) || object.Equals(sRight, TypeSymbol.String)) {
                    return TypeSymbol.String
                }
                if sLeft != nil && TypeSymbol.IsLegalPointeeType(sLeft) {
                    return sLeft
                }
                if sRight != nil && TypeSymbol.IsLegalPointeeType(sRight) {
                    return sRight
                }
                return nil
            }
            case cond is ConditionalExpressionSyntax {
                return InferCalleeExpressionType(
                    cond.WhenTrue,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                ) ??
                    InferCalleeExpressionType(
                    cond.WhenFalse,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
            }
            case blockExpr is BlockExpressionSyntax {
                return InferCalleeExpressionType(
                    blockExpr.Expression,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
            }
            case namedTupleElem is NamedTupleElementSyntax {
                return InferCalleeExpressionType(
                    namedTupleElem.Expression,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
            }
            case tupleLit is TupleLiteralExpressionSyntax {
                let elemBuilder = ImmutableArray.CreateBuilder[TypeSymbol](tupleLit.Elements.Count)
                for elem in tupleLit.Elements {
                    guard let elemType = InferCalleeExpressionType(
                        elem,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    ) else {
                        return nil
                    }
                    elemBuilder.Add(elemType)
                }
                return TupleTypeSymbol.Get(elemBuilder.MoveToImmutable())
            }
            case ifExpr is IfExpressionSyntax {
                return InferCalleeExpressionType(
                    ifExpr.ThenBlock,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                ) ??
                    InferCalleeExpressionType(
                    ifExpr.ElseExpression,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
            }
            case idx is IndexExpressionSyntax {
                let targetType = InferCalleeExpressionType(
                    idx.Target,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                return GetElementOrIndexerTypeOf(targetType)
            }
            case call is CallExpressionSyntax {
                if call.Callee == nil &&
                    call.ConversionTypeClause == nil &&
                    call
                    .Identifier
                    .ValueText == "cast" &&
                    call
                    .TypeArgumentList
                    ?.Arguments
                    .Count == 1 {
                    return ResolveCalleeTypeClause(call.TypeArgumentList!!.Arguments[0], calleeTypeParams)
                }
                if call.ConversionTypeClause != nil {
                    return ResolveCalleeTypeClause(call.ConversionTypeClause, calleeTypeParams)
                }
                if call.Callee == nil {
                    let fnName = call.Identifier.ValueText
                    if enclosingType != nil {
                        if GetMethodReturnTypeOnType(enclosingType, fnName, List[TypeSymbol?]()) is {} encRet {
                            return encRet
                        }
                    }
                    let fns = $scope.TryLookupFunctions(fnName)
                    if !fns.IsDefaultOrEmpty {
                        return fns[0].Type
                    }
                    for importedType in binderCtx.GetStaticImportTypes() {
                        for m in importedType.StaticMethods {
                            if m.Name == fnName {
                                return m.Type
                            }
                        }
                    }
                    if ResolveCalleeNamedType(fnName, call.TypeArgumentList, calleeTypeParams) is {} constructed {
                        return constructed
                    }
                }
                return nil
            }
            case acc is AccessorExpressionSyntax {
                if TryGetDottedAccessorName(acc, out var dotted) {
                    let firstSeg = FirstNameSegment(dotted)
                    if !localTypes.ContainsKey(firstSeg) && !parameters.ContainsKey(firstSeg) && $scope.TryLookupSymbol(
                        firstSeg
                    ) !is VariableSymbol &&
                        (LookupCompilationTypeByName(dotted, 0) ?? ResolveTestedType(dotted, 0)) is {} qualifiedType {
                        isTypeReceiver = true
                        return qualifiedType
                    }
                }
                let leftType = InferCalleeExpressionType(
                    acc.LeftPart,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes,
                    out _
                )
                return InferCalleeAccessorRightType(
                    leftType,
                    acc.RightPart,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes
                )
            }
            default {
                return nil
            }
        }
    }

    private func TryGetDottedAccessorName(expr ExpressionSyntax?, out dotted string) bool {
        dotted = ""
        switch expr {
            case name is NameExpressionSyntax {
                dotted = name.IdentifierToken.ValueText
                return true
            }
            case acc is AccessorExpressionSyntax {
                if TryGetDottedAccessorName(acc.LeftPart, out var left) &&
                    TryGetDottedAccessorName(acc.RightPart, out var right) {
                    dotted = left + "." + right
                    return true
                }
                return false
            }
            default {
                return false
            }
        }
    }

    private func InferCalleeAccessorRightType(
        prefixType TypeSymbol?,
        right ExpressionSyntax?,
        origCallee FunctionSymbol,
        enclosingType TypeSymbol?,
        parameters Dictionary[string, ParameterSymbol],
        calleeTypeParams Dictionary[string, TypeParameterSymbol],
        localTypes Dictionary[string, TypeSymbol?]
    ) TypeSymbol? {
        if prefixType == nil || right == nil {
            return nil
        }
        switch right {
            case name is NameExpressionSyntax {
                return GetMemberTypeOnType(prefixType, name.IdentifierToken.ValueText)
            }
            case unary is UnaryExpressionSyntax when unary.OperatorToken.Kind == SyntaxKind.BangBangToken {
                let inner = InferCalleeAccessorRightType(
                    prefixType,
                    unary.Operand,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes
                )
                return if inner is NullableTypeSymbol n {
                    n.UnderlyingType
                } else {
                    inner
                }
            }
            case idx is IndexExpressionSyntax {
                let targetType = InferCalleeAccessorRightType(
                    prefixType,
                    idx.Target,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes
                )
                return GetElementOrIndexerTypeOf(targetType)
            }
            case call is CallExpressionSyntax {
                let mName = call.Identifier.ValueText
                if mName == "Select" && call.Arguments.Count == 1 {
                    let arg0 = call.Arguments[0]
                    if arg0 is LambdaExpressionSyntax selLambda {
                        let elemType = GetElementOrIndexerTypeOf(prefixType)
                        for p in selLambda.Parameters {
                            if p.Identifier is {} pId && pId.ValueText.Length > 0 {
                                localTypes[pId.ValueText] = ResolveCalleeTypeClause(p.Type, calleeTypeParams) ??
                                    elemType
                            }
                        }
                        if selLambda.Body is ExpressionSyntax bodyExpr {
                            if InferCalleeExpressionType(
                                bodyExpr,
                                origCallee,
                                enclosingType,
                                parameters,
                                calleeTypeParams,
                                localTypes,
                                out _
                            ) is {} projectedElem {
                                return SequenceTypeSymbol.Get(projectedElem)
                            }
                        }
                    } else if InferCalleeExpressionType(
                        arg0,
                        origCallee,
                        enclosingType,
                        parameters,
                        calleeTypeParams,
                        localTypes,
                        out _
                    ) is FunctionTypeSymbol fnType {
                        return SequenceTypeSymbol.Get(fnType.ReturnType)
                    }
                }
                if mName is "Where" or
                    "Skip" or
                    "Take" or
                    "Distinct" or
                    "OrderBy" or
                    "OrderByDescending" or
                    "ThenBy" or
                    "Reverse" {
                    return prefixType
                }
                if mName is "ToArray" or "ToImmutableArray" or "ToList" {
                    if GetElementOrIndexerTypeOf(prefixType) is {} elem {
                        return SliceTypeSymbol.Get(elem)
                    }
                }
                if mName is "First" or
                    "FirstOrDefault" or
                    "Last" or
                    "LastOrDefault" or
                    "Single" or
                    "SingleOrDefault" or
                    "ElementAt" or
                    "ElementAtOrDefault" {
                    return GetElementOrIndexerTypeOf(prefixType)
                }
                let argTypes = List[TypeSymbol?](call.Arguments.Count)
                for arg in call.Arguments {
                    argTypes.Add(
                        InferCalleeExpressionType(
                            arg,
                            origCallee,
                            enclosingType,
                            parameters,
                            calleeTypeParams,
                            localTypes,
                            out _
                        )
                    )
                }
                return GetMethodReturnTypeOnType(prefixType, mName, argTypes)
            }
            case nested is AccessorExpressionSyntax {
                let midType = InferCalleeAccessorRightType(
                    prefixType,
                    nested.LeftPart,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes
                )
                return InferCalleeAccessorRightType(
                    midType,
                    nested.RightPart,
                    origCallee,
                    enclosingType,
                    parameters,
                    calleeTypeParams,
                    localTypes
                )
            }
            default {
                return nil
            }
        }
    }

    private func GetMemberTypeOnType(receiverType TypeSymbol?, memberName string) TypeSymbol? {
        let stripped = StripAllNullability(receiverType) ?? receiverType
        switch stripped {
            case nil {
                return nil
            }
            case ArrayTypeSymbol, SliceTypeSymbol, RectangularArrayTypeSymbol {
                if memberName is "Length" or "Count" or "Capacity" {
                    return TypeSymbol.Int32
                }
            }
            case tuple is TupleTypeSymbol {
                if tuple.TryGetElementIndexByName(memberName, out var element) {
                    return tuple.ElementTypes[element]
                }
                if memberName.StartsWith("Item", StringComparison.Ordinal) && int32.TryParse(
                    memberName.Substring(4),
                    out var position
                ) &&
                    position >= 1 &&
                    position <= tuple
                    .ElementTypes
                    .Length {
                    return tuple.ElementTypes[position - 1]
                }
                if int32.TryParse(memberName, out var zeroIdx) && zeroIdx >= 0 && zeroIdx < tuple.ElementTypes.Length {
                    return tuple.ElementTypes[zeroIdx]
                }
                return nil
            }
            case s is StructSymbol {
                for level in s.GetHierarchy() {
                    for f in level.Fields {
                        if f.Name == memberName {
                            return s.SubstituteMemberType(f.Type) ?? level.SubstituteMemberType(f.Type) ?? f.Type
                        }
                    }
                    for sf in level.StaticFields {
                        if sf.Name == memberName {
                            return s.SubstituteMemberType(sf.Type) ?? level.SubstituteMemberType(sf.Type) ?? sf.Type
                        }
                    }
                    for p in level.Properties {
                        if p.Name == memberName && !p.IsIndexer {
                            return s.SubstituteMemberType(p.Type) ?? level.SubstituteMemberType(p.Type) ?? p.Type
                        }
                    }
                    for sp in level.StaticProperties {
                        if sp.Name == memberName && !sp.IsIndexer {
                            return s.SubstituteMemberType(sp.Type) ?? level.SubstituteMemberType(sp.Type) ?? sp.Type
                        }
                    }
                }
                if s.GetHierarchy().Last().ImportedBaseType is {} impBase {
                    return GetMemberTypeOnType(impBase, memberName)
                }
                return nil
            }
            case iface is InterfaceSymbol {
                for level in iface.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    for p in level.Properties {
                        if p.Name == memberName && !p.IsIndexer {
                            return iface.SubstituteMemberType(level.SubstituteMemberType(p.Type))
                        }
                    }
                }
                return nil
            }
            default { }
        }
        let clr = (stripped as ImportedTypeSymbol)?.OpenDefinition ?? stripped?.ClrType
        if clr == nil || ReflectionType(clr) is not{} reflected {
            return nil
        }
        try {
            let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
            for clrMem in reflected.GetMember(memberName, flags) {
                if clrMem is FieldInfo clrField {
                    return MemberLookup.GetClrFieldTypeSymbol(stripped!!, clrField) ??
                        ClrNullability.GetFieldTypeSymbol(clrField)
                }
                if clrMem is PropertyInfo clrProp && clrProp.GetIndexParameters().Length == 0 {
                    let pType = MemberLookup.GetClrPropertyTypeSymbol(stripped!!, clrProp) ??
                        ClrNullability.GetPropertyTypeSymbol(clrProp)
                    return if pType is ByRefTypeSymbol byRefProp {
                        byRefProp.PointeeType
                    } else {
                        pType
                    }
                }
            }
        } catch (ex NotSupportedException) { }
        return nil
    }

    private func GetMethodReturnTypeOnType(
        receiverType TypeSymbol?,
        methodName string,
        argTypes List[TypeSymbol?]
    ) TypeSymbol? {
        let stripped = StripAllNullability(receiverType) ?? receiverType
        switch stripped {
            case nil {
                return nil
            }
            case s is StructSymbol {
                for level in s.GetHierarchy() {
                    for m in level.Methods {
                        if m.Name == methodName {
                            return s.SubstituteMemberType(m.Type) ?? level.SubstituteMemberType(m.Type) ?? m.Type
                        }
                    }
                    for m in level.StaticMethods {
                        if m.Name == methodName {
                            return s.SubstituteMemberType(m.Type) ?? level.SubstituteMemberType(m.Type) ?? m.Type
                        }
                    }
                }
                if s.GetHierarchy().Last().ImportedBaseType is {} impBase {
                    return GetMethodReturnTypeOnType(impBase, methodName, argTypes)
                }
                return nil
            }
            case iface is InterfaceSymbol {
                for level in iface.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    for m in level.GetMethods(methodName) {
                        return iface.SubstituteMemberType(level.SubstituteMemberType(m.Type))
                    }
                    for m in level.GetStaticMethods(methodName) {
                        return iface.SubstituteMemberType(level.SubstituteMemberType(m.Type))
                    }
                    for m in level.PrivateMethods {
                        if m.Name == methodName {
                            return iface.SubstituteMemberType(level.SubstituteMemberType(m.Type))
                        }
                    }
                    for m in level.StaticPrivateMethods {
                        if m.Name == methodName {
                            return iface.SubstituteMemberType(level.SubstituteMemberType(m.Type))
                        }
                    }
                }
                return nil
            }
            default { }
        }
        let clr = (stripped as ImportedTypeSymbol)?.OpenDefinition ?? stripped?.ClrType
        if clr == nil || ReflectionType(clr) is not{} reflected {
            return nil
        }
        try {
            let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
            for clrMem in reflected.GetMember(methodName, flags) {
                if clrMem is MethodInfo clrMethod {
                    if clrMethod.IsGenericMethodDefinition && argTypes.Count > 0 {
                        if InferClrGenericMethodReturnType(clrMethod, argTypes) is {} inferredRet {
                            return inferredRet
                        }
                    }
                    let retType = MemberLookup.GetClrMethodReturnTypeSymbol(stripped!!, clrMethod) ??
                        ClrNullability.GetReturnTypeSymbol(clrMethod)
                    return if retType is ByRefTypeSymbol byRefRet {
                        byRefRet.PointeeType
                    } else {
                        retType
                    }
                }
            }
        } catch (ex NotSupportedException) { }
        return nil
    }

    private func InferClrGenericMethodReturnType(clrMethod MethodInfo, argTypes List[TypeSymbol?]) TypeSymbol? {
        let genParams = clrMethod.GetGenericArguments()
        let methodParams = clrMethod.GetParameters()
        let inferred = [genParams.Length]TypeSymbol?
        let count = Math.Min(argTypes.Count, methodParams.Length)
        for var i = 0; i < count; i++ {
            if argTypes[i] is {} argType {
                MatchClrGenericParameterFromArgument(methodParams[i].ParameterType, argType, inferred)
            }
        }
        var retClr = clrMethod.ReturnType
        if retClr.IsByRef {
            retClr = retClr.GetElementType() ?? retClr
        }
        if retClr.IsGenericParameter &&
            retClr.DeclaringMethod != nil &&
            retClr.GenericParameterPosition < inferred.Length {
            return inferred[retClr.GenericParameterPosition]
        }
        if retClr.IsGenericType {
            let openRet = retClr.GetGenericTypeDefinition()
            let retGenArgs = retClr.GetGenericArguments()
            let substArgs = ImmutableArray.CreateBuilder[TypeSymbol](retGenArgs.Length)
            for gArg in retGenArgs {
                if gArg.IsGenericParameter &&
                    gArg.DeclaringMethod != nil &&
                    gArg.GenericParameterPosition < inferred.Length &&
                    inferred[gArg.GenericParameterPosition] is {} infArg {
                    substArgs.Add(infArg)
                } else {
                    return nil
                }
            }
            return ImportedTypeSymbol.GetConstructed(openRet, openRet, substArgs.MoveToImmutable())
        }
        return nil
    }

    private func MatchClrGenericParameterFromArgument(paramClrType Type, argSymbol TypeSymbol, inferred[]TypeSymbol?) {
        let strippedArg = StripAllNullability(argSymbol) ?? argSymbol
        var pType = paramClrType
        if pType.IsByRef {
            pType = pType.GetElementType() ?? pType
        }
        if pType.IsGenericParameter &&
            pType.DeclaringMethod != nil &&
            pType.GenericParameterPosition < inferred.Length {
            inferred[pType.GenericParameterPosition] ??= strippedArg
            return
        }
        if pType.IsArray && pType.GetElementType() is {} pElem {
            if GetElementOrIndexerTypeOf(strippedArg) is {} argElem {
                MatchClrGenericParameterFromArgument(pElem, argElem, inferred)
            }
            return
        }
        if pType.IsGenericType && strippedArg is ImportedTypeSymbol impArg && !impArg.TypeArguments.IsDefaultOrEmpty {
            let pGenArgs = pType.GetGenericArguments()
            let count = Math.Min(pGenArgs.Length, impArg.TypeArguments.Length)
            for var i = 0; i < count; i++ {
                MatchClrGenericParameterFromArgument(pGenArgs[i], impArg.TypeArguments[i], inferred)
            }
        }
    }

    private func GetElementOrIndexerTypeOf(targetType TypeSymbol?) TypeSymbol? {
        let stripped = StripAllNullability(targetType) ?? targetType
        switch stripped {
            case nil {
                return nil
            }
            case arr is ArrayTypeSymbol {
                return arr.ElementType
            }
            case slice is SliceTypeSymbol {
                return slice.ElementType
            }
            case rect is RectangularArrayTypeSymbol {
                return rect.ElementType
            }
            case seq is SequenceTypeSymbol {
                return seq.ElementType
            }
            case mapType is MapTypeSymbol {
                return mapType.ValueType
            }
            case s is StructSymbol {
                for level in s.GetHierarchy() {
                    for p in level.Properties {
                        if p.IsIndexer {
                            return s.SubstituteMemberType(p.Type) ?? level.SubstituteMemberType(p.Type) ?? p.Type
                        }
                    }
                }
                if s.GetHierarchy().Last().ImportedBaseType is {} impBase {
                    return GetElementOrIndexerTypeOf(impBase)
                }
                return nil
            }
            case iface is InterfaceSymbol {
                for level in iface.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    for p in level.Properties {
                        if p.IsIndexer {
                            return iface.SubstituteMemberType(level.SubstituteMemberType(p.Type))
                        }
                    }
                }
                return nil
            }
            case imp is ImportedTypeSymbol {
                if !imp.TypeArguments.IsDefaultOrEmpty {
                    let openName = (imp.OpenDefinition ?? imp.ClrType)?.FullName ?? ""
                    if openName.StartsWith("System.Collections.Generic.Dictionary`", StringComparison.Ordinal) ||
                        openName.StartsWith("System.Collections.Generic.IDictionary`", StringComparison.Ordinal) ||
                        openName.StartsWith(
                        "System.Collections.Generic.IReadOnlyDictionary`",
                        StringComparison.Ordinal
                    ) ||
                        openName.StartsWith("System.Collections.Generic.SortedDictionary`", StringComparison.Ordinal) ||
                        openName.StartsWith("System.Collections.Generic.SortedList`", StringComparison.Ordinal) ||
                        openName
                        .StartsWith("System.Collections.Concurrent.ConcurrentDictionary`", StringComparison.Ordinal) {
                        if imp.TypeArguments.Length >= 2 {
                            return imp.TypeArguments[1]
                        }
                    }
                    return imp.TypeArguments[0]
                }
            }
            default { }
        }
        if object.Equals(stripped, TypeSymbol.String) {
            return TypeSymbol.Char
        }
        let clr = (stripped as ImportedTypeSymbol)?.OpenDefinition ?? stripped?.ClrType
        if clr == nil || ReflectionType(clr) is not{} reflected {
            return nil
        }
        if reflected.IsArray && reflected.GetElementType() is {} elemClr {
            return TypeSymbol.FromClrTypeWithoutNullability(elemClr, NullabilityFreeReason.ResolvedTypeName)
        }
        try {
            for prop in reflected.GetProperties(
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.FlattenHierarchy
            ) {
                if prop.GetIndexParameters().Length > 0 {
                    let pType = MemberLookup.GetClrPropertyTypeSymbol(stripped!!, prop) ??
                        ClrNullability.GetPropertyTypeSymbol(prop)
                    return if pType is ByRefTypeSymbol byRefProp {
                        byRefProp.PointeeType
                    } else {
                        pType
                    }
                }
            }
        } catch (ex NotSupportedException) { }
        return nil
    }
}
