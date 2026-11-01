// <copyright file="StatementBinder.NarrowingLoops.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// ADR-0213 section 20, slice L0: the loop comparison. At each loop whose entry
/// state holds a fact, the binder computes the lower bound `Lower(S, R)` of
/// section 6 from the walker (cref:RegionEffectScanner) and compares it, fact by
/// fact, with what today's back-edge analysis removes. It writes every
/// disagreement to the `.loops` report of (cref:NarrowingComparison). At each
/// function with a backward `goto` it computes the span of section 11 and
/// reports it.
/// @remarks Nothing here changes the frames, the diagnostics or the bound tree.
/// The mechanism is off unless (cref:NarrowingComparison.LoopsEnabled) is true.
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
    }

    private var packageDeclaresConversions bool? = nil

    // Whether a type of the package declares a user-defined conversion operator.
    private func PackageDeclaresConversions() bool {
        if packageDeclaresConversions == nil {
            var found = false
            for declared in $scope.GetDeclaredStructs() {
                for method in declared.StaticMethods {
                    if method.Name == "op_Implicit" || method.Name == "op_Explicit" {
                        found = true
                    }
                }
            }
            packageDeclaresConversions = found
        }
        return packageDeclaresConversions == true
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

    private func ResolveRegionWrites(effects RegionEffects) ResolvedRegionWrites {
        let resolved = ResolvedRegionWrites()
        if effects.ContainsConversionCandidate {
            resolved.RunsUserCodeOnWrite = true
        }
        // A returned name or constant runs no conversion operator when its type keeps its representation in the
        // return type, or when the return type is built in (a user conversion needs a type of the package).
        let enclosing = function
        let returnType = if enclosing == nil || enclosing.IsReturnTypeInferred {
            default(TypeSymbol?)
        } else {
            StripAllNullability(enclosing.Type)
        }
        if effects.ReturnsConstant && (returnType == nil || !MetadataTypeKeys.IsBuiltIn(returnType)) {
            resolved.RunsUserCodeOnWrite = true
        }
        for name in effects.ReturnedNames {
            let returned = if $scope.TryLookupSymbol(name) is VariableSymbol variable {
                StripAllNullability(variable.Type)
            } else {
                default(TypeSymbol?)
            }
            if returned == nil || returnType == nil || !Conversion.IsRepresentationPreservingImplicit(
                returned,
                returnType
            ) {
                resolved.RunsUserCodeOnWrite = true
            }
        }
        if effects.ContainsOperatorCandidate {
            // A unary operator that is not predefined for a literal or a built-in operand calls a user-defined or
            // an extension operator (`-"x"`), as does a binary one with an extension operator.
            resolved.RunsUserOperator = effects.OperatorHasUnresolvedOperand || OperatorsRunUserCode(effects, false)
            for name in effects.OperatorOperandNames {
                // A declaration of the region is not found here, and its type is unknown: it counts.
                if $scope.TryLookupSymbol(name) is VariableSymbol operand {
                    let operandType = StripAllNullability(operand.Type)
                    // `object` can hold a value of a type with operators.
                    if operandType == nil || !MetadataTypeKeys.IsBuiltIn(operandType) || object.Equals(
                        operandType,
                        TypeSymbol.Object
                    ) {
                        resolved.RunsUserOperator = true
                    }
                } else {
                    resolved.RunsUserOperator = true
                }
            }
        }
        for name in effects.NilCompareOperandNames {
            if $scope.TryLookupSymbol(name) is VariableSymbol compared {
                let comparedType = compared.Type
                // A non-nullable value type compared with `nil` may select a user-defined `==`.
                if comparedType != nil &&
                    (
                    object.Equals(StripAllNullability(comparedType), TypeSymbol.Object) ||
                        (comparedType !is NullableTypeSymbol && !IsReferenceLikeType(comparedType))
                ) {
                    resolved.RunsUserOperator = true
                    resolved.NilCompareRunsUserOperator = true
                }
            }
        }
        for name in effects.BareReads {
            let symbol = $scope.TryLookupSymbol(name)
            if symbol is ImplicitPropertyVariableSymbol or ImplicitStaticPropertyVariableSymbol {
                resolved.ReadsProperty = true
            }
            if symbol is ImplicitPropertyVariableSymbol{Property: {IsAutoProperty: false}} or
                ImplicitStaticPropertyVariableSymbol{Property: {IsAutoProperty: false}} {
                resolved.ReadsUserCodeProperty = true
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
                continue
            }
            if variable is ImplicitPropertyVariableSymbol or ImplicitStaticPropertyVariableSymbol {
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
        effects.ContainsMemberRead ||
        resolved.RunsUserOperator ||
        resolved.RunsUserCodeOnWrite ||
        resolved.ReadsProperty

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
        if test.MayBeConstant && $scope.TryLookupSymbol(typeName) != nil {
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
    private func ResolveReceiverPath(path RegionReceiverPath, effects RegionEffects) List[ReceiverType]? {
        var types = List[ReceiverType]()
        if path.RootType != nil {
            if ResolveTypeClause(path.RootType) is not{} declared {
                return nil
            }
            types.Add(ReceiverType(declared, nil))
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
        for step in path.Steps {
            let next = List[ReceiverType]()
            for type in types {
                if AddStepTypes(type, step, next) != StepFound {
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
            return enclosing != nil && !enclosing.IsReturnTypeInferred && AddSymbolType(enclosing.Type, types)
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
                if !AddSymbolType(function.Type, types) {
                    return false
                }
            }
            return true
        }
        let symbol = $scope.TryLookupSymbol(root)
        if symbol is VariableSymbol variable {
            if !AddSymbolType(variable.Type, types) {
                return false
            }
            let narrowed = binderCtx.NarrowedVariables.Query(AccessPath.ForVariable(variable))
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
        if ResolveTypeName(root) is {} named {
            types.Add(ReceiverType(named, nil))
            return true
        }
        return false
    }

    // Adds a type symbol without its nullability. A type parameter that a member returns is substituted by the
    // binder, which the walker does not do, so it does not resolve.
    private func AddSymbolType(type TypeSymbol?, types List[ReceiverType]) bool {
        let stripped = StripAllNullability(type)
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
            return AddClrStepTypes(clr, step, ImmutableArray[TypeSymbol].Empty, nil, next)
        }
        let symbol = type.Symbol
        let elementStep = step.Kind == RegionReceiverStepKind.Index || step.Kind == RegionReceiverStepKind.Element
        switch symbol {
            case nil {
                return StepUnresolved
            }
            case array is ArrayTypeSymbol {
                if elementStep {
                    return Outcome(AddSymbolType(array.ElementType, next))
                }
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
                return AddClrStepTypes(typeof(object), step, ImmutableArray[TypeSymbol].Empty, nil, next)
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
            case imported is ImportedTypeSymbol {
                if imported.OpenDefinition is {} definition && !imported.TypeArguments.IsDefaultOrEmpty {
                    return AddClrStepTypes(definition, step, imported.TypeArguments, definition, next)
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
        return AddClrStepTypes(clrType, step, arguments, nil, next)
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

    private func MemberType(candidate Symbol) TypeSymbol? {
        switch candidate {
            case field is FieldSymbol {
                return field.Type
            }
            case property is PropertySymbol {
                return property.Type
            }
            case function is FunctionSymbol {
                return function.Type
            }
            case declaredEvent is EventSymbol {
                return declaredEvent.Type
            }
            default {
                return nil
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
        // Only a public member can be named after a dot or indexed; an explicit interface implementation cannot.
        let flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
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
                        if property.GetIndexParameters().Length > 0 {
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

    // Whether an operator of the region can be user code: an operand whose type does not resolve, is not built in or
    // is `object`, a unary operator that is not predefined for its operand (after `char` promotion, as the
    // expression binder does), or a binary operator that is not predefined and has an extension operator.
    // For a fact on by-reference storage ([`forReferenceStorage`](paramref)), a source operator (of a type of the
    // package or an extension operator) is a plain call that ADR-0208 A3 exempts, as on main; an imported operator is
    // not.
    private func OperatorsRunUserCode(
        effects RegionEffects,
        forReferenceStorage bool,
        onlyResolvedOperands bool = false
    ) bool {
        for candidate in effects.Operators {
            // A known built-in operand type, or `nil` for an operand that is itself an operator expression.
            let operandTypes = List[TypeSymbol?]()
            for var index = 0; index < candidate.Operands.Count; index++ {
                let operand = candidate.Operands[index]
                if operand == nil {
                    if !candidate.OperatorForms[index] && !onlyResolvedOperands {
                        return true
                    }
                    operandTypes.Add(nil)
                } else if BuiltInOperandType(operand, effects) is {} operandType {
                    operandTypes.Add(operandType)
                } else if onlyResolvedOperands {
                    if ResolveReceiverPath(operand, effects) != nil {
                        return true
                    }
                    operandTypes.Add(nil)
                } else if !forReferenceStorage || OperandIsImportedType(operand, effects) {
                    return true
                } else {
                    operandTypes.Add(nil)
                }
            }
            if operandTypes.Count == 1 {
                if operandTypes[0] is not{} operandType {
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
                HasExtensionOperator(candidate.Kind, operandTypes[0], operandTypes[1]) {
                return true
            }
        }
        return false
    }

    // Whether an operand resolves to an imported type that is not built in, whose operators are imported methods. An
    // operand that does not resolve is not counted here (the walker cannot type a call result such as an extension
    // method's).
    private func OperandIsImportedType(operand RegionReceiverPath, effects RegionEffects) bool {
        if ResolveReceiverPath(operand, effects) is not{} types {
            return false
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

    private func HasExtensionOperator(kind SyntaxKind, left TypeSymbol?, right TypeSymbol?) bool {
        if OperatorNames.TryGetBinaryName(kind) is not{} name {
            return false
        }
        if left != nil && $scope.TryLookupExtensionFunction(left, name, out var leftOperator) {
            return true
        }
        return right != nil && $scope.TryLookupExtensionFunction(right, name, out var rightOperator)
    }

    // The one built-in type of an operand, or `nil` when it does not resolve to one.
    // The built-in type of an operand, or `nil` when it does not resolve to one. Candidates of several built-in types
    // (the overloads of `Math.Max`) give the first, since each has the same operators by kind.
    private func BuiltInOperandType(operand RegionReceiverPath, effects RegionEffects) TypeSymbol? {
        if ResolveReceiverPath(operand, effects) is not{} types || types.Count == 0 {
            return nil
        }
        var first TypeSymbol? = nil
        for candidate in types {
            let type = if candidate.Clr is {} clr {
                BuiltInType(clr.FullName)
            } else {
                candidate.Symbol
            }
            if type == nil || !MetadataTypeKeys.IsBuiltIn(type) || object.Equals(type, TypeSymbol.Object) {
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
    // conversion classifier, `HasUserDefinedImplicitConversion`). A site that the walker cannot follow can.
    private func ConversionsRunUserCode(effects RegionEffects) bool {
        for conversion in effects.Conversions {
            let targetPath = conversion.Target
            if targetPath == nil {
                return true
            }
            let targets = ConversionTypes(targetPath, effects)
            if targets == nil {
                return true
            }
            let sourcePath = conversion.Source
            if sourcePath == nil {
                // An operator or a literal of built-in operands converts only to a type that is not built in. A
                // user-defined or extension operator of the region may return another type.
                if !conversion.SourceIsBuiltInByForm ||
                    OperatorsRunUserCode(effects, false, onlyResolvedOperands: true) {
                    return true
                }
                for target in targets {
                    if !MetadataTypeKeys.IsBuiltIn(target) {
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
                        (MetadataTypeKeys.IsBuiltIn(source) && MetadataTypeKeys.IsBuiltIn(target)) {
                        continue
                    }
                    if conversions.HasUserDefinedImplicitConversion(source, target) {
                        return true
                    }
                }
            }
        }
        return false
    }

    // Whether a call of the region passes a value that a user-defined or imported conversion operator converts to its
    // parameter type (the predicate of the conversion classifier). The candidates are the functions or methods of
    // the callee's name with as many parameters as arguments. A candidate that takes every argument without a
    // conversion operator (the same or a built-in type, a reference conversion or a type parameter) is taken to be
    // the one that binds. A call whose callee or arguments do not resolve is not checked.
    private func ArgumentsRunUserConversion(effects RegionEffects) bool {
        for call in effects.Calls {
            if call.Arguments.Count == 0 || call.CalleeName is not{} name {
                continue
            }
            let argumentTypes = List[List[TypeSymbol]]()
            var resolvedArguments = true
            for argument in call.Arguments {
                if argument == nil || ConversionTypes(argument, effects) is not{} types {
                    resolvedArguments = false
                    break
                }
                argumentTypes.Add(types)
            }
            if !resolvedArguments {
                continue
            }
            let candidates = ParameterLists(call, name, effects)
            var anyFits = false
            var anyNeedsOperator = false
            for parameters in candidates {
                if parameters.Count != argumentTypes.Count {
                    continue
                }
                var fits = true
                var convertible = true
                for var index = 0; index < parameters.Count; index++ {
                    for argumentType in argumentTypes[index] {
                        if ArgumentFits(argumentType, parameters[index]) {
                            continue
                        }
                        fits = false
                        if !conversions.HasUserDefinedImplicitConversion(argumentType, parameters[index]) {
                            convertible = false
                        }
                    }
                }
                anyFits = anyFits || fits
                anyNeedsOperator = anyNeedsOperator || (!fits && convertible)
            }
            if !anyFits && anyNeedsOperator {
                return true
            }
        }
        return false
    }

    private func ArgumentFits(argument TypeSymbol, parameter TypeSymbol) bool {
        let stripped = StripAllNullability(parameter) ?? parameter
        return object.Equals(argument, stripped) || TypeSymbol.ContainsTypeParameter(stripped) || object.Equals(
            stripped,
            TypeSymbol.Object
        ) ||
            (MetadataTypeKeys.IsBuiltIn(argument) && MetadataTypeKeys.IsBuiltIn(stripped)) ||
            Conversion.IsRepresentationPreservingImplicit(argument, stripped)
    }

    // The parameter types of each function or method that the call can bind: the functions of the scope with the
    // callee's name, or the methods of that name on the receiver's types.
    private func ParameterLists(call RegionCall, name string, effects RegionEffects) List[List[TypeSymbol]] {
        let lists = List[List[TypeSymbol]]()
        var receivers List[ReceiverType]? = nil
        if call.Kind == RegionCallKind.NamedInvocation {
            for function in $scope.TryLookupFunctions(name) {
                lists.Add(ParameterTypes(function))
            }
            return lists
        }
        if call.Kind != RegionCallKind.MemberInvocation {
            return lists
        }
        if call.ReceiverName is {} receiverName {
            let types = List[ReceiverType]()
            if AddRootTypes(receiverName, false, effects, types) {
                receivers = types
            }
        } else if call.Receiver is {} path {
            receivers = ResolveReceiverPath(path, effects)
        }
        if receivers == nil {
            return lists
        }
        for receiver in receivers {
            AddMethodParameterLists(receiver, name, lists)
        }
        return lists
    }

    private func ParameterTypes(function FunctionSymbol) List[TypeSymbol] {
        let types = List[TypeSymbol]()
        for parameter in function.Parameters {
            types.Add(parameter.Type)
        }
        return types
    }

    private func AddMethodParameterLists(receiver ReceiverType, name string, lists List[List[TypeSymbol]]) {
        var clrType = receiver.Clr
        switch receiver.Symbol {
            case declared is StructSymbol {
                for level in declared.GetHierarchy() {
                    for candidate in level.GetMembers() {
                        if candidate is FunctionSymbol function && function.Name == name {
                            lists.Add(ParameterTypes(function))
                        }
                    }
                }
                clrType = declared.GetHierarchy().Last().ImportedBaseType?.ClrType
            }
            case contract is InterfaceSymbol {
                for level in contract.SelfAndAllBaseInterfaces() {
                    level.EnsureMembersResolved()
                    for function in level.GetMethods(name) {
                        lists.Add(ParameterTypes(function))
                    }
                }
            }
            case imported is ImportedTypeSymbol {
                clrType = imported.OpenDefinition ?? imported.ClrType
            }
            default {
                clrType = clrType ?? receiver.Symbol?.ClrType
            }
        }
        if clrType == nil || ReflectionType(clrType) is not{} reflected {
            return
        }
        try {
            for member in reflected.GetMember(
                name,
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy
            ) {
                if member is MethodInfo method {
                    let types = List[TypeSymbol]()
                    for parameter in method.GetParameters() {
                        types.Add(ClrNullability.GetParameterTypeSymbol(parameter))
                    }
                    lists.Add(types)
                }
            }
        } catch (ex NotSupportedException) { }
    }

    private func ConversionTypes(path RegionReceiverPath, effects RegionEffects) List[TypeSymbol]? {
        if ResolveReceiverPath(path, effects) is not{} types {
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

    private func ReadsRunUserCode(effects RegionEffects) bool {
        for read in effects.MemberReads {
            if ReadRunsUserCode(read, effects) {
                return true
            }
        }
        return false
    }

    // Whether a member or index read can run user code, with the rules of the straight-line pass: a field, a
    // tuple element, an array element and an enum member run none; a source property runs user code unless it is
    // an auto property (R14); an imported property or indexer runs user code unless `IsStableClrAccessor` lists it
    // (R16, R17). A receiver that does not resolve can run user code.
    private func ReadRunsUserCode(read RegionMemberRead, effects RegionEffects) bool {
        let path = read.Receiver
        if path == nil || path.Steps.Length > 0 && effects.ContainsMemberTypeTest {
            return true
        }
        let types = ResolveReceiverPath(path, effects)
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

    private func ReadOfTypeRunsUserCode(type ReceiverType, member string?) bool {
        if type.Clr is {} clr {
            return ClrReadRunsUserCode(clr, member, false)
        }
        let symbol = type.Symbol
        switch symbol {
            case nil {
                return true
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
                                    // A constant is inlined and initializes nothing.
                                    return field.IsStatic &&
                                        !field.IsConst &&
                                        TypeInitializationRunsUserCode(level, true)
                                }
                                case property is PropertySymbol {
                                    return !property.IsAutoProperty ||
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

    // An imported read: a field or a constant runs no user code; a property or an indexer runs user code unless
    // `IsStableClrAccessor` lists its getter. A member that is not found can run user code.
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
                        if clrMember is FieldInfo {
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
            return !found
        } catch (ex NotSupportedException) {
            return true
        }
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
                if $scope.TryLookupSymbol(write.RightSideName) is VariableSymbol asserted {
                    let assertedType = StripAllNullability(asserted.Type)
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
        filterNames HashSet[string]?
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
            resolved.RunsUserCodeOnWrite
        // Rule W5: every member or index read is an unknown getter, which is a call.
        let readLike = effects.ContainsMemberRead || resolved.ReadsProperty
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
        // Coordinator decision 2026-11-01 (pending maintainer review; amendment A3 is the more permissive
        // alternative): a getter or an indexer that can run user code (ADR-0208 R14, R16 and R17) removes the fact
        // of storage that a reference names, as on main, because the code can write the storage that the
        // reference aliases. Only such a fact needs the answer, so the reads are resolved only for it.
        // The same holds for a user-defined or imported operator or conversion and a static initializer (ADR-0208
        // A3 exempts only a plain call to a method).
        if !indirectCall && NamesReferenceStorage(path) {
            if resolved.ReadsRunUserCode == nil {
                resolved.ReadsRunUserCode = resolved.ReadsUserCodeProperty ||
                    resolved.TouchesInitializingType ||
                    resolved.NilCompareRunsUserOperator ||
                    ReadsRunUserCode(effects) ||
                    OperatorsRunUserCode(effects, true) ||
                    ConversionsRunUserCode(effects) ||
                    ArgumentsRunUserConversion(effects)
            }
            indirectCall = resolved.ReadsRunUserCode == true
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
        if filterNames != nil && (effects.ContainsHandler || callLike || readLike) {
            if filterNames.Contains(root.Name) || MayBeMutatedByUnknownCallable(path) {
                return RegionKillDecision(true, "W8", "R10")
            }
        }
        // ADR-0208 amendment A3: a plain call does not kill the fact of a by-reference parameter. A callable of
        // unknown origin and user code the table lists (a getter, a constructor, a loop header) keep the full kill.
        let unknownWrite = if indirectCall {
            MayBeMutatedByUnknownWrite(mayMutateAnyRoot, effects.ContainsPointerWrite, path)
        } else {
            MayBeMutatedByUnknownWrite(mayMutateAnyRoot && !IsByReferenceRoot(root), effects.ContainsPointerWrite, path)
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
    /// frames, `R` the region of the loop. A fact that the consumer rule of section 7 removes leaves its
    /// frame, and stays out of it after the loop. The external callable aliases that the region may
    /// reassign leave their set. When `GSHARP_NARROWING_COMPARE` is set, the decision for every fact goes
    /// to the `.loops` report.
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
            InvalidateInheritedNarrowings(invalidations)
            externalCallableAliases.Clear()
            CompilationMeasurements.Count("narrowing.region-facts-killed", cast[int64](invalidations.Count))
            if NarrowingComparison.LoopsEnabled {
                NarrowingComparison.ReportLoopSummary(
                    body.Location,
                    invalidations.Count,
                    invalidations.Count,
                    0,
                    "no-loop-parent"
                )
            }
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
        let resolved = ResolveRegionWrites(effects)
        var filterNames HashSet[string]? = nil
        if effects.ContainsHandler || RegionRunsCode(effects, resolved) {
            let filters = CollectCatchFiltersAbove(loop)
            if filters.Count > 0 {
                filterNames = CollectEnclosingFilterNames(filters)
            }
        }
        // S: the facts of the frames. A path that two frames hold is reported once, for the innermost frame.
        let reported = List[AccessPath]()
        var factCount = 0
        var killedCount = 0
        var memberReadsWithLiveFacts = 0
        let location = loop.Location
        for var i = frameCount - 1; i >= 0; i-- {
            for entry in binderCtx.NarrowedVariables[i] {
                let path = entry.Key
                let decision = DecideRegionKill(path, entry.Value, effects, resolved, filterNames)
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
                factCount++
                if decision.Killed {
                    killedCount++
                    CompilationMeasurements.Count("narrowing.region-facts-killed")
                }
                if effects.MemberReadCount > 0 && MayBeMutatedByUnknownCallable(path) {
                    memberReadsWithLiveFacts++
                }
                if NarrowingComparison.LoopsEnabled && decision.Killed {
                    NarrowingComparison.ReportLoopKill(
                        location,
                        path.ToString(),
                        FactKind(path, entry.Value),
                        decision.Rule,
                        decision.Row
                    )
                }
            }
        }
        InvalidateInheritedNarrowings(invalidations)
        // ADR-0213 section 13: a function value that the region may reassign is no longer external at the
        // loop header, so a call in the loop can reach a closure.
        if effects.ContainsUnknownKind || effects.ContainsPointerWrite {
            externalCallableAliases.Clear()
        } else if externalCallableAliases.Count > 0 && resolved.Roots.Count > 0 {
            externalCallableAliases.RemoveWhere(
                (alias VariableSymbol) -> resolved.Roots.Any(
                    (written VariableSymbol) -> SameRoot(written, alias) || MayShareStorage(written, alias)
                )
            )
        }
        if effects.MemberReadCount > 0 {
            CompilationMeasurements.Count("narrowing.region-member-reads", cast[int64](effects.MemberReadCount))
            if memberReadsWithLiveFacts > 0 {
                CompilationMeasurements.Count(
                    "narrowing.region-member-reads-with-live-facts",
                    cast[int64](effects.MemberReadCount)
                )
            }
        }
        if NarrowingComparison.LoopsEnabled {
            NarrowingComparison.ReportLoopSummary(
                location,
                factCount,
                killedCount,
                factCount - killedCount,
                "nodes=${effects.NodesVisited} reads=${effects.MemberReadCount} ${effects}"
            )
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

    // The facts that the header of a loop proves when the loop ends, by loop statement. Row R7 (f).
    private let loopExitFacts Dictionary[SyntaxNode, Dictionary[AccessPath, TypeSymbol]] = Dictionary[
        SyntaxNode,
        Dictionary[AccessPath, TypeSymbol]
    ]()

    /// Row R7 (f), table 9 column `Exit state`: a loop without a `break` ends only when its header is
    /// false, so the facts that the condition proves false hold after the loop whatever the body wrote.
    /// The header is bound under the lower bound of the loop, so each fact holds on every iteration.
    /// A fact that the condition itself may remove is dropped, as for a statement (rule A2).
    /// @remarks A loop with a `break` keeps today's exit (no fact is added): the states of the `break`
    /// statements are not recorded yet, so the join of table 9 cannot be taken. The same holds in a
    /// function with a user label or `goto` (#4285).
    private func RecordLoopExitFacts(loopBody StatementSyntax, condition BoundExpression?) {
        if condition == nil {
            return
        }
        let loop = loopBody.Parent
        if loop == nil {
            return
        }
        let elseFacts = ComputeConditionNarrowing(condition).Else
        if elseFacts == nil || elseFacts.Count == 0 {
            return
        }
        let hasBreak = ContainsBreakFor(loop)
        if NarrowingComparison.LoopsEnabled {
            for entry in elseFacts {
                // The frames hold the state after the loop. A fact that they hold is not a gain.
                if binderCtx.NarrowedVariables.Query(entry.Key) != nil {
                    continue
                }
                let text = if entry.Key.HasMembers {
                    ""
                } else {
                    entry.Key.Root.Name
                }
                NarrowingComparison.ReportLoopExitGain(
                    loop.Location,
                    entry.Key.ToString(),
                    hasBreak,
                    FindBangSitesAfter(loop, text)
                )
            }
        }
        // The loop ends when the header is false, so the break of a block expression in the header or in the post
        // statement also leaves it: the whole loop is scanned.
        if hasBreak || binderCtx.FunctionContainsUserGotoOrLabel {
            return
        }
        // The effects of the header decide which facts survive it, by the same rule as the entry (A2): a call,
        // a getter, an operator, a write to the root, a write through `ref` or a filter of an enclosing try.
        let headerSyntax = HeaderSyntax(loop)
        if headerSyntax == nil {
            return
        }
        let headerEffects = GetRegionScanner().ScanStatements([]SyntaxNode{headerSyntax})
        let resolved = ResolveRegionWrites(headerEffects)
        let filters = CollectCatchFiltersAbove(loop)
        var filterNames HashSet[string]? = nil
        if filters.Count > 0 {
            filterNames = CollectEnclosingFilterNames(filters)
        }
        let facts = Dictionary[AccessPath, TypeSymbol]()
        for entry in elseFacts {
            let path = entry.Key
            // The enclosing filters apply when the header has a handler or runs code (W8, in `DecideRegionKill`).
            let removed = DecideRegionKill(path, entry.Value, headerEffects, resolved, filterNames).Killed
            if !removed {
                facts[path] = entry.Value
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

    /// Adds the facts that the header of the loop statement [`syntax`](paramref) proves on exit to
    /// [`persistentFrame`](paramref). It runs after the statement's invalidation, which removes the
    /// roots that the body writes: the exit state is the state of the header, not of the body.
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
            SetPersistentNarrowing(persistentFrame, entry.Key, entry.Value)
        }
    }

    private func ContainsBreakFor(node SyntaxNode) bool {
        if node.Kind == SyntaxKind.BreakStatement {
            return true
        }
        for child in node.GetChildren() {
            if ContainsBreakFor(child) {
                return true
            }
        }
        return false
    }

    // The `name!!` sites after the loop in its statement list and in the lists that enclose it, up to
    // the function. An upper bound: the walk does not stop at a write to the name.
    private func FindBangSitesAfter(loop SyntaxNode, name string) string {
        if name.Length == 0 {
            return "-"
        }
        let sites = List[string]()
        var child SyntaxNode = loop
        var parent = loop.Parent
        while parent != nil {
            if parent is BlockStatementSyntax block {
                var seenChild = false
                for statement in block.Statements {
                    if seenChild {
                        CollectBangSites(statement, name, sites)
                    } else if object.ReferenceEquals(statement, child) {
                        seenChild = true
                    }
                }
            }
            if parent is FunctionDeclarationSyntax or
                FunctionLiteralExpressionSyntax or
                LambdaExpressionSyntax or
                ConstructorDeclarationSyntax or
                PropertyAccessorSyntax {
                break
            }
            child = parent
            parent = parent.Parent
        }
        return if sites.Count == 0 {
            "-"
        } else {
            string.Join(";", sites)
        }
    }

    private func CollectBangSites(node SyntaxNode, name string, sites List[string]) {
        if node is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.BangBangToken}} assertion {
            var operand ExpressionSyntax = assertion.Operand
            while operand is ParenthesizedExpressionSyntax parenthesized {
                operand = parenthesized.Expression
            }
            if operand is NameExpressionSyntax identifier && identifier.IdentifierToken.ValueText == name {
                sites.Add(NarrowingComparison.Format(assertion.Location))
            }
        }
        for child in node.GetChildren() {
            CollectBangSites(child, name, sites)
        }
    }

    /// Computes and reports the backward-jump span of the function that holds the label at
    /// [`labeled`](paramref) (ADR-0213 section 11). A function asks once per label, and it counts once.
    private func ReportBackwardJumpSpan(labeled SyntaxNode) {
        var function SyntaxNode? = nil
        for var current SyntaxNode? = cast[SyntaxNode?](labeled); current != nil; current = current!!.Parent {
            if current is FunctionDeclarationSyntax or
                FunctionLiteralExpressionSyntax or
                LambdaExpressionSyntax or
                ConstructorDeclarationSyntax or
                PropertyAccessorSyntax or
                EventAccessorSyntax or
                DeinitDeclarationSyntax {
                function = current
                break
            }
        }
        if function == nil {
            return
        }
        let location = function.Location
        if !NarrowingComparison.TryRegisterSpanFunction(
            NarrowingComparison.Format(location) + ":" + function.Span.Start.ToString()
        ) {
            return
        }
        var body SyntaxNode? = nil
        if function is FunctionDeclarationSyntax declaration {
            body = declaration.Body
        } else if function is FunctionLiteralExpressionSyntax literal {
            body = literal.Body
        } else if function is ConstructorDeclarationSyntax constructor {
            body = constructor.Body
        } else if function is PropertyAccessorSyntax accessor {
            body = accessor.Body
        } else if function is EventAccessorSyntax eventAccessor {
            body = eventAccessor.Body
        } else if function is DeinitDeclarationSyntax destructor {
            body = destructor.Body
        } else if function is LambdaExpressionSyntax lambda && lambda.Body is BlockExpressionSyntax lambdaBlock {
            body = lambdaBlock
        }
        if body == nil {
            return
        }
        let span = BackwardJumpSpans.Compute(body)
        if span == nil {
            return
        }
        NarrowingComparison.TryRegisterSpanFunction(
            "span:" + NarrowingComparison.Format(location) + ":" + function.Span.Start.ToString()
        )
        let effects = GetRegionScanner().ScanStatements(span.Statements())
        NarrowingComparison.ReportSpan(
            span.FirstStatement.Location,
            "labels=${string.Join(",", span.Labels)} gotos=${span.GotoCount}",
            effects.ToString()
        )
    }
}
