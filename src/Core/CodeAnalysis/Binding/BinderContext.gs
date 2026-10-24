// <copyright file="BinderContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System.Linq
import System.Reflection

/// Cross-cutting state shared across a single (cref:Binder) instance
/// and (in subsequent extraction PRs) the components a (cref:Binder)
/// composes — `MemberLookup`, `ConversionClassifier`,
/// `OverloadResolver`, and so on.
/// @remarks PR-B-1 introduces this type as the foundation for the Binder decomposition
/// described in the repository-level decomposition plan. No methods are moved
/// in this PR; only the cross-cutting state that downstream extractions will
/// need to consume via constructor injection is centralised here.
///
/// State that is deliberately <em>not</em> on (cref:BinderContext):
/// the per-binder (cref:FunctionSymbol) (it is per-binder, not cross-
/// cutting), the pending interface-implementation checks list (declaration-
/// specific; moves in PR-B-8), and the static readonly attribute-target
/// hashsets (they are constants).
internal class BinderContext {
    /// Counter used to allocate unique (cref:BoundLabel) identifiers.
    /// Mutated in place by callers (sometimes via
    /// (cref:System.Threading.Interlocked.Increment(ref int))), so it
    /// must remain a field rather than a property.
    var LabelCounter int32

    /// Counter used to allocate unique synthetic-local names for null-
    /// conditional receiver captures. Mutated in place by callers.
    var NullConditionalCaptureCounter int32

    /// Issue #1238: set transiently by the argument-binding loops just before
    /// eagerly binding a top-level conditional (`if`/`else`),
    /// ternary, or `switch`-expression argument that has no target type
    /// yet. When set, those branchy binders suppress a no-common-type
    /// unification failure (instead of reporting it) and return a placeholder
    /// carrying the original syntax, so the argument can be re-bound with the
    /// resolved parameter type as its target once overload resolution picks the
    /// applicable method/constructor. The flag is read-and-cleared by the
    /// branchy binder so nested sub-expressions bind with normal (non-deferred)
    /// semantics.
    var DeferTargetlessConditional bool

    /// Counter used to allocate unique synthetic-local names for general
    /// binder-introduced temporaries. Mutated in place by callers via
    /// (cref:System.Threading.Interlocked.Increment(ref int)).
    var SyntheticLocalCounter int32

    /// Counter used to allocate unique synthetic-local names for captured
    /// `defer` argument values. Mutated in place by callers.
    var DeferArgumentCounter int32

    /// Counter used to allocate unique synthetic-local names for discarded
    /// `out` argument receivers. Mutated in place by callers.
    var OutDiscardCounter int32

    /// ADR-0122 / issue #1014. Nesting depth of the current `unsafe`
    /// context. Greater than zero inside an `unsafe func`, the body of an
    /// `unsafe class` / `unsafe struct`, or an `unsafe { … }`
    /// block. When in an unsafe context the prefix `*T` type clause binds
    /// to an <em>unmanaged</em> pointer ((cref:Symbols.PointerTypeSymbol),
    /// `ELEMENT_TYPE_PTR`) rather than a managed by-ref
    /// ((cref:Symbols.ByRefTypeSymbol)), and raw-pointer operations
    /// (dereference, indexing, pointer arithmetic, pointer casts) are permitted.
    /// Mutated in place via (cref:PushUnsafeContext).
    var UnsafeDepth int32

    /// Nesting depth while binding base or delegating-constructor arguments.
    /// Instance access is unavailable until the selected constructor has run.
    var ConstructorInitializerDepth int32

    private let narrowingProofGenerations Dictionary[NarrowingFrame, (Generation int32, Depth int32)] = Dictionary[
        NarrowingFrame,
        (Generation int32, Depth int32)
    ](ReferenceEqualityComparer.Instance)
    private var narrowingProofGeneration int32

    private var channelRuntime ChannelRuntimeBinder?
    private var closureAssignedNames HashSet[string]?
    private var closureAssignedNamesComputed bool

    /// Initializes a new instance of the (cref:BinderContext) class.
    /// @param parent The parent (cref:BoundScope) against which
    /// the binder's root scope is created.
    init(parent BoundScope) {
        Services = parent.GetBindingServices()
        Diagnostics = DiagnosticBag()
        ScopeFrames = Stack[VariableSymbol]()
        AsyncLetCells = Stack[List[AsyncLetVariableSymbol]]()
        ScopeContexts = Stack[VariableSymbol]()
        LoopStack = Stack[(LabelName string?, BreakLabel BoundLabel, ContinueLabel BoundLabel?)]()
        UsedBreakLabels = HashSet[BoundLabel]()
        UserLabels = Dictionary[string, BoundLabel]()
        DefinedUserLabels = HashSet[string]()
        UnresolvedGotoLabels = Dictionary[string, TextLocation]()
        PendingGotoAssignmentStarts = Dictionary[string, int32]()
        AssignmentNarrowingGenerations = Dictionary[VariableSymbol, int32]()
        PendingGotoNarrowingSnapshots = Dictionary[string, List[GotoNarrowingSnapshot]]()
        BackwardGotoNarrowingStates = Dictionary[string, BackwardGotoNarrowingState]()
        ReachableUserLabels = HashSet[string](StringComparer.Ordinal)
        DeferredUnreachableGotoEdges = List[(SourceLabel string?, TargetLabel string, Snapshot GotoNarrowingSnapshot)]()
        NarrowedVariables = NarrowingFrameStack()
        PendingEarlyExitFrames = Dictionary[BoundIfStatement, Dictionary[AccessPath, TypeSymbol]]()
        PendingSwitchExitFrames = Dictionary[BoundPatternSwitchStatement, Dictionary[AccessPath, TypeSymbol]]()
        PendingPatternVariableLeaks = Dictionary[BoundIfStatement, ImmutableArray[LocalVariableSymbol]]()
        PatternVariableNames = HashSet[string](StringComparer.Ordinal)
        InitialScope = BoundScope(parent)
        RootScope = InitialScope
    }

    /// Gets the services of the binding pass this context's binder belongs to (issue #5140):
    /// the state keyed by the reference set, imports and referencing file that every body's
    /// binder shares.
    prop Services BindingServices {
        get;
    }

    /// Gets the diagnostics bag for the binder this context backs.
    prop Diagnostics DiagnosticBag {
        get;
    }

    /// Gets the lowering of channel operations onto the `Gsharp.Runtime.Channels`
    /// runtime (ADR-0174 D1), resolved once per binder against the compilation's reference set.
    prop ChannelRuntime ChannelRuntimeBinder -> (
        if channelRuntime == nil {
            (channelRuntime = ChannelRuntimeBinder(References))
        } else {
            channelRuntime
        }
    )!!

    /// Gets the hidden `ScopeFrame` locals of the enclosing (ADR-0174 D5/D6)
    /// `scope` blocks, innermost on top. A `go` statement reports to
    /// the top frame; an empty stack means the runtime's free sink.
    prop ScopeFrames Stack[VariableSymbol] {
        get;
    }

    /// Gets the `async let` bindings declared directly in each enclosing
    /// `scope` block (ADR-0174 D15), innermost on top. The block's cleanup
    /// cancels and joins every one that was never awaited, and GS0559 names
    /// them.
    prop AsyncLetCells Stack[List[AsyncLetVariableSymbol]] {
        get;
    }

    /// Gets the implicit `ctx` local of each enclosing `scope` block
    /// (ADR-0174 D7), innermost on top. A channel operation binds against the
    /// innermost one, so cancelling the block unblocks operations parked inside
    /// it; outside every scope the operations run under `Context.None`.
    prop ScopeContexts Stack[VariableSymbol] {
        get;
    }

    /// Gets the binder's initial scope. Unlike (cref:RootScope), this
    /// remains stable while nested statement binding pushes child scopes.
    prop InitialScope BoundScope {
        get;
    }

    /// Gets the reference resolver associated with the binder's scope chain.
    /// Provided as a first-class accessor so downstream extracted components
    /// don't need to reach through (cref:RootScope).
    prop References ReferenceResolver -> RootScope.References!!

    /// Gets a value indicating whether binding is currently inside an
    /// `unsafe` context (ADR-0122 / issue #1014). When true the prefix
    /// `*T` type clause binds to an unmanaged pointer
    /// ((cref:Symbols.PointerTypeSymbol)) and raw-pointer operations are
    /// permitted.
    prop InUnsafeContext bool -> UnsafeDepth > 0

    /// Gets a value indicating whether constructor-initializer arguments are being bound.
    prop InConstructorInitializer bool -> ConstructorInitializerDepth > 0

    /// Gets or sets the iterator return clause allowed to carry an unconstrained nullable sequence element.
    prop UnconstrainedNullableSequenceElementReturn TypeClauseSyntax?

    /// Gets a value indicating whether the current `checked`/`unchecked`
    /// arithmetic context is checked (issue #1881): `true` inside
    /// a `checked(...)` expression or a `checked { }` statement,
    /// `false` inside `unchecked(...)`/`unchecked { }` or when no
    /// such context has been entered (the C# project default is unchecked).
    /// Innermost context wins — (cref:PushCheckedContext) saves and
    /// restores the previous value, so nesting `checked { unchecked { … } }`
    /// resolves correctly. Only observed by the Sum/Difference/Product binary
    /// operator and by narrowing numeric conversions.
    prop IsCheckedContext bool {
        get;
        private set;
    }

    /// Gets or sets the scope the binder currently operates against. Starts
    /// at the binder's root scope; mutated during nested-scope push/pop by
    /// statement, expression, and lambda binding helpers — so a writable
    /// accessor is required.
    prop RootScope BoundScope

    /// Gets the stack of (label-name, break-label, continue-label) tuples
    /// maintained for loop bodies during binding. The `LabelName`
    /// element is `null` for unlabeled loops; ADR-0070
    /// labeled `break` / `continue` resolve their target by
    /// scanning this stack for a matching label name.
    /// @remarks Issue #3501 A3: a `switch` statement also pushes a frame so an
    /// unlabeled `break` in an arm exits the switch (C#/Go alignment).
    /// A switch frame has a `null` `ContinueLabel` and
    /// a `null` `LabelName` — `continue` binding
    /// skips such frames to reach the enclosing loop.
    prop LoopStack Stack[(LabelName string?, BreakLabel BoundLabel, ContinueLabel BoundLabel?)] {
        get;
    }

    /// Gets the set of break labels that were actually targeted by a bound
    /// `break` statement (issue #3501 A3) — a switch appends its
    /// break-label statement only when someone jumped to it, so exhaustive
    /// all-paths-return switches keep their exit shape.
    prop UsedBreakLabels HashSet[BoundLabel] {
        get;
    }

    /// Gets or sets the label a legal `fallthrough` in the CURRENT
    /// switch arm jumps to — the next arm's body-entry label (issue #3501
    /// A3). `null` when the current arm cannot fall through
    /// (final arm, or no fallthrough present). Set by
    /// `BindSwitchStatement` per arm; cleared by lambda nested frames.
    prop CurrentFallthroughTarget BoundLabel?

    /// Gets or sets the one syntax node in the current switch arm where a
    /// `fallthrough` is legal — the arm body's LAST statement (issue
    /// #3501 A3). Any other `fallthrough` reports GS0168.
    prop CurrentFallthroughAnchor StatementSyntax?

    /// Gets the enclosing function's user-defined `goto` labels
    /// (issue #1884): a label placed on any non-loop statement, keyed by
    /// name. Populated by a pre-pass over the function body before any
    /// statement is bound, so a `goto` may target a label declared
    /// later in the same function (forward reference). Fresh per function/
    /// lambda/local-function — matches ADR-0070's "label namespace is local
    /// to the enclosing function" rule.
    prop UserLabels Dictionary[string, BoundLabel] {
        get;
    }

    /// Gets the set of user-defined `goto` label names (issue #1884)
    /// that have already been declared via a `label: statement` in this
    /// function. Used to detect a duplicate label declaration (GS0470).
    prop DefinedUserLabels HashSet[string] {
        get;
    }

    /// Gets the user-defined `goto` label names (issue #1884) that have
    /// been referenced by a `goto` but not yet declared, keyed to the
    /// location of the first such reference. Checked once the enclosing
    /// function finishes binding (`StatementBinder.FinalizeUserLabels`);
    /// any name still present is an undefined label (GS0469).
    prop UnresolvedGotoLabels Dictionary[string, TextLocation] {
        get;
    }

    /// Gets the assignment-narrowing generation at which each unresolved
    /// forward-goto target was first encountered.
    prop PendingGotoAssignmentStarts Dictionary[string, int32] {
        get;
    }

    /// Gets the latest assignment-narrowing generation for each variable.
    prop AssignmentNarrowingGenerations Dictionary[VariableSymbol, int32] {
        get;
    }

    /// Gets or sets the current assignment-narrowing generation.
    prop AssignmentNarrowingGeneration int32

    /// Gets the variables known non-null at each forward `goto` source,
    /// grouped by target label. Label joins retain a later assignment
    /// narrowing when every incoming jump already carried that proof.
    prop PendingGotoNarrowingSnapshots Dictionary[string, List[GotoNarrowingSnapshot]] {
        get;
    }

    /// Gets the label-entry narrowing state, narrowing-dependent member reads,
    /// and incoming snapshots for backward user gotos.
    prop BackwardGotoNarrowingStates Dictionary[string, BackwardGotoNarrowingState] {
        get;
    }

    prop ReachableUserLabels HashSet[string] {
        get;
    }

    prop DeferredUnreachableGotoEdges List[(SourceLabel string?, TargetLabel string, Snapshot GotoNarrowingSnapshot)] {
        get;
    }

    prop PotentialReachabilityLabel string?

    /// Gets or sets a value indicating whether the CURRENT function/lambda/
    /// local-function body contains any user-written `goto` statement or non-loop
    /// `label:` declaration (issue #4285), computed syntactically,
    /// once, before that body is bound — see
    /// (cref:StatementBinder.ContainsUserGotoOrLabel). Consulted by
    /// (cref:StatementBinder.ApplyEarlyExitNarrowings) to
    /// conservatively suppress the early-exit / post-switch narrowing lift
    /// for the whole body whenever it holds: a `goto` anywhere in the
    /// function can jump directly into a region a nil-guard's implicit exit
    /// was assumed to dominate, bypassing the guard and invalidating the
    /// narrowing's soundness proof. Fresh per function/lambda/local-function,
    /// matching (cref:UserLabels)'s scoping — reset and recomputed by
    /// `LambdaBinder.EnterNestedFrame` for a nested function-literal or
    /// arrow-lambda body, and restored by `LambdaBinder.RestoreNestedFrame`.
    prop FunctionContainsUserGotoOrLabel bool

    /// Gets the stack of per-scope variable-narrowing tables used by pattern
    /// matching and flow analysis. Each entry maps a variable to its narrowed
    /// type within the corresponding scope.
    prop NarrowedVariables NarrowingFrameStack {
        get;
    }

    /// Wraps [`frame`](paramref) in a narrowing frame, starts its proof and pushes
    /// it. Pop it with (cref:EndNarrowingProof). Use the returned frame for later writes:
    /// a write to the dictionary itself is not seen by the stack.
    func PushNarrowingFrame(frame Dictionary[AccessPath, TypeSymbol]) NarrowingFrame {
        let pushed = NarrowingFrame(frame)
        BeginNarrowingProof(pushed)
        NarrowedVariables.Add(pushed)
        return pushed
    }

    /// Gets the narrowing facts that hold now, as a value (ADR-0208 section 7).
    /// @remarks The stack threads the value beside the frames: the innermost
    /// frame that holds a path wins. The frame stack stays the mechanism until the
    /// consuming PR replaces it. The value has no external-callable facts, which
    /// the statement binder owns.
    /// Gets or sets the facts that the shadow join proves and that no frame holds
    /// (ADR-0208 section 19, PR 1). Only the comparison mode reads or writes it.
    internal var ShadowOverlay NarrowingState = NarrowingState.Empty

    /// Gets or sets, for each overlay path, the frame type at the time the overlay
    /// fact was made. A frame fact that differs from it is newer than the overlay fact.
    internal var ShadowOverlayBase NarrowingState = NarrowingState.Empty

    /// Gets the paths whose frame facts a header or a guard removed in the shadow
    /// flow, with the frame count at that time. A frame below that count holds an
    /// inherited fact, which is gone; a frame at or above it holds a newer proof.
    internal let ShadowSuppressed Dictionary[AccessPath, int32] = Dictionary[AccessPath, int32]()

    /// Whether the innermost frame fact of [`path`](paramref) is an inherited
    /// fact that the shadow flow removed.
    internal func ShadowIsSuppressed(path AccessPath) bool {
        if ShadowSuppressed.Count == 0 || !ShadowSuppressed.TryGetValue(path, out var depth) {
            return false
        }
        for var i = NarrowedVariables.Count - 1; i >= 0; i-- {
            if NarrowedVariables[i].ContainsKey(path) {
                return i < depth
            }
        }
        return false
    }

    /// Returns the type that the shadow flow gives a read of [`path`](paramref),
    /// where [`frameType`](paramref) is the frame answer. The newer of the frame
    /// fact and the overlay fact wins.
    internal func ShadowEffectiveType(path AccessPath, legacyType TypeSymbol?) TypeSymbol? {
        let frameType = if ShadowIsSuppressed(path) {
            default(TypeSymbol?)
        } else {
            legacyType
        }
        let overlayType = ShadowOverlay.NarrowedType(path)
        if overlayType == nil {
            return frameType
        }
        if frameType == nil {
            return overlayType
        }
        let baseType = ShadowOverlayBase.NarrowedType(path)
        return if baseType != nil && object.Equals(baseType, frameType) {
            overlayType
        } else {
            frameType
        }
    }

    internal prop Narrowing NarrowingState -> NarrowedVariables.State

    /// Gets the side-table that parks the else-branch narrowing frame of an
    /// `if`-statement keyed by the resulting bound
    /// (cref:BoundIfStatement) node identity. ADR-0069 / issue #700:
    /// `BindBlockStatements` consults this table and lifts the frame
    /// into the enclosing block's persistent narrowing scope when the
    /// then-branch ends in an unconditional exit (return, throw, break,
    /// continue), so subsequent reads in the block see the narrowing.
    prop PendingEarlyExitFrames Dictionary[BoundIfStatement, Dictionary[AccessPath, TypeSymbol]] {
        get;
    }

    /// Gets the side-table that parks the post-switch narrowing frame for a
    /// `switch` statement keyed by the resulting bound
    /// (cref:BoundPatternSwitchStatement) node identity. ADR-0069
    /// addendum / issue #712: when every non-default arm either ends in an
    /// unconditional exit OR contributes the same narrowing on the
    /// discriminator (and the default arm, if any, does likewise), the
    /// common narrowing is lifted into the enclosing block's persistent
    /// narrowing scope so subsequent reads in the block see the narrowing.
    prop PendingSwitchExitFrames Dictionary[BoundPatternSwitchStatement, Dictionary[AccessPath, TypeSymbol]] {
        get;
    }

    /// Gets the ADR-0166 side-table that parks the pattern variables an
    /// `if`-statement leaks into the statements that follow it, keyed by
    /// the resulting (cref:BoundIfStatement). `BindIfStatement`
    /// records the condition's when-false variables when the then-branch ends
    /// in an unconditional exit (and the when-true variables when the else-
    /// branch does); `BindBlockStatements` declares them into the enclosing
    /// block scope, the same lift (cref:PendingEarlyExitFrames) performs
    /// for smart-cast narrowings.
    prop PendingPatternVariableLeaks Dictionary[BoundIfStatement, ImmutableArray[LocalVariableSymbol]] {
        get;
    }

    /// Gets the names of every ADR-0166 pattern variable bound in this binder's
    /// body. An unresolved name that matches one is reported as a pattern
    /// variable read outside the region its match dominates (GS0532) rather
    /// than as an unknown variable.
    prop PatternVariableNames HashSet[string] {
        get;
    }

    /// Gets or sets the type-parameter dictionary in scope while binding a
    /// generic function body. Indexed by type-parameter name. `null` when
    /// no generic context is active.
    prop CurrentTypeParameters Dictionary[string, TypeParameterSymbol]?

    /// Gets or sets the user type whose declaration body is currently being
    /// bound. Member bodies normally carry this through their
    /// (cref:FunctionSymbol), while member signatures need this ambient
    /// context before their function symbol exists.
    prop CurrentContainingType TypeSymbol?

    func CanUseNativeBufferAlias(
        $scope BoundScope,
        identifier SyntaxToken,
        currentFunction FunctionSymbol?,
        expression bool = false
    ) bool -> (identifier.Text is "slice" or "array") &&
        CanUseIntrinsicAlias($scope, identifier, currentFunction, expression)

    func CanUseIntrinsicAlias(
        $scope BoundScope,
        identifier SyntaxToken,
        currentFunction FunctionSymbol?,
        expression bool = false
    ) bool {
        if CurrentTypeParameters?.ContainsKey(identifier.ValueText) ?? false {
            return false
        }
        if TryLookupSourceType($scope, identifier.ValueText, -1, currentFunction, out _, out var ambiguous) ||
            ambiguous ||
            $scope.HasImportedTypeName(identifier.ValueText) {
            return false
        }
        return !expression || !HasValueName($scope, identifier.ValueText)
    }

    func HasValueName($scope BoundScope, name string) bool -> $scope.TryLookupSymbol(name) != nil ||
        !$scope
        .TryLookupFunctions(name).IsDefaultOrEmpty || GetStaticImportTypes().Any(
        (type StructSymbol) -> ImportedTypeExposesStaticMember(type, name)
    ) ||
        $scope
        .EnumerateStaticImportClrTypes().Any((type Type) -> ClrTypeExposesStaticMember(type, name))

    /// Resolves a source type at the current binding site. Lexically visible
    /// nested types on the containing type or an accessible base type are
    /// considered before the compilation-wide simple-name table.
    /// @param scope The current bound scope.
    /// @param name The requested simple type name.
    /// @param preferredArity The exact requested arity, or -1 when unspecified.
    /// @param currentFunction The function currently being bound, if any.
    /// @param type The resolved source type.
    /// @param ambiguousAcrossImportedPackages Whether global source lookup was ambiguous across imported
    /// packages.
    /// @returns Whether a source type was found.
    func TryLookupSourceType(
        $scope BoundScope,
        name string,
        preferredArity int32,
        currentFunction FunctionSymbol?,
        @NotNullWhen(true) out type TypeSymbol?,
        out ambiguousAcrossImportedPackages bool
    ) bool {
        let currentContainingType TypeSymbol? = CurrentContainingType ??
            currentFunction?.ReceiverType ??
            currentFunction?.StaticOwnerType ??
            currentFunction?.LexicalEnclosingType
        if currentContainingType != nil && $scope.TryLookupLexicalNestedTypeAlias(
            currentContainingType,
            name,
            preferredArity,
            out type
        ) {
            ambiguousAcrossImportedPackages = false
            return true
        }
        let foundSource = $scope.TryLookupTypeAlias(name, preferredArity, out type, out ambiguousAcrossImportedPackages)
        if foundSource &&
            type is {} sourceType &&
            ImportedTypeOverridesSourceType(
            $scope,
            name,
            sourceType,
            preferredArity,
            currentFunction,
            importedType: nil
        ) &&
            $scope
            .TryResolveExplicitSourceTypeAlias(name, preferredArity, out var aliasedSourceType) {
            type = aliasedSourceType
            ambiguousAcrossImportedPackages = false
            return true
        }
        if foundSource || ambiguousAcrossImportedPackages {
            return foundSource
        }
        return $scope.TryResolveExplicitSourceTypeAlias(name, preferredArity, out type)
    }

    /// Returns whether an imported type should override a same-named source
    /// type at the current binding site.
    /// @param scope The current bound scope.
    /// @param importedName The imported name used at the binding site.
    /// @param sourceType The source type found by simple-name lookup.
    /// @param requestedArity The exact requested arity, or -1 when no arity was specified.
    /// @param currentFunction The function currently being bound, if any.
    /// @param importedType The resolved CLR import target, if any.
    /// @returns `true` when an explicit alias exists, or the resolved
    /// CLR target is top-level, and the source fallback has the wrong requested
    /// arity or is nested outside its lexical/accessibility scope.
    func ImportedTypeOverridesSourceType(
        $scope BoundScope,
        importedName string,
        sourceType TypeSymbol,
        requestedArity int32,
        currentFunction FunctionSymbol?,
        importedType Type?
    ) bool {
        let ContainingType = func (type TypeSymbol?) TypeSymbol? {
            return switch type {
                case s is StructSymbol: s.ContainingType
                case e is EnumSymbol: e.ContainingType
                case i is InterfaceSymbol: i.ContainingType
                case d is DelegateTypeSymbol: d.ContainingType
                default: default(TypeSymbol?)
            }
        }
        let Definition = func (type TypeSymbol) TypeSymbol {
            return switch type {
                case s is StructSymbol: cast[TypeSymbol](s.Definition!!)
                case e is EnumSymbol: cast[TypeSymbol](e.Definition!!)
                case i is InterfaceSymbol: cast[TypeSymbol](i.Definition!!)
                case d is DelegateTypeSymbol: cast[TypeSymbol](d.Definition ?? d)
                default: type
            }
        }
        let TypeAccessibility = func (type TypeSymbol) Accessibility {
            return switch type {
                case s is StructSymbol: s.Accessibility
                case e is EnumSymbol: e.Accessibility
                case i is InterfaceSymbol: i.Accessibility
                case d is DelegateTypeSymbol: d.Accessibility
                default: Accessibility.Private
            }
        }
        let Arity = func (type TypeSymbol) int32 {
            return switch type {
                case s is StructSymbol when s.IsGenericDefinition: s.TypeParameters.Length
                case i is InterfaceSymbol when i.IsGenericDefinition: i.TypeParameters.Length
                case d is DelegateTypeSymbol when d.IsGenericDefinition: d.TypeParameters.Length
                default: 0
            }
        }
        let explicitAlias = $scope.TryLookupImport(importedName, out var import_) && import_!!.IsAlias
        if !explicitAlias && !(importedType != nil && importedType.IsNested == false) {
            return false
        }
        if requestedArity >= 0 && Arity(sourceType) != requestedArity {
            return true
        }
        let sourceContainer TypeSymbol? = ContainingType(sourceType)
        if sourceContainer == nil {
            return false
        }
        let currentContainer = CurrentContainingType ??
            currentFunction?.ReceiverType ??
            currentFunction?.StaticOwnerType ??
            currentFunction?.LexicalEnclosingType
        for var current TypeSymbol? = currentContainer; current != nil; current = ContainingType(current) {
            if object.ReferenceEquals(Definition(current), Definition(sourceContainer)) {
                return false
            }
            if current is not StructSymbol currentStruct || sourceContainer is not StructSymbol sourceStruct {
                continue
            }
            // Issue #4164: this used to walk `.BaseClass` directly with no
            // cycle guard, reached from TryLookupSourceType — the same
            // declaration-time type-clause lookup entry point implicated in
            // #4164's traced hang — before the post-bind cycle detector
            // (#973) has run. `currentStruct.GetHierarchy()` is the single
            // guarded walk (fixed by #4162); skip the first entry
            // (`currentStruct` itself) to match this loop's original
            // `currentStruct.BaseClass` starting point.
            let baseChain = currentStruct.GetHierarchy()
            for var level = 1; level < baseChain.Count; level++ {
                let baseType = baseChain[level]
                if object.ReferenceEquals(Definition(baseType), Definition(sourceStruct)) &&
                    AccessibilityChecker.IsAccessibleFromType(
                    TypeAccessibility(sourceType),
                    sourceStruct,
                    currentStruct
                ) {
                    return false
                }
            }
        }
        return true
    }

    /// Issue #1201: resolves the compilation's non-alias type imports
    /// (`import Ns.Type`) to the user-defined (cref:StructSymbol)s
    /// whose `shared` (static) members are thereby brought into scope for
    /// unqualified reference — the G# equivalent of C#'s `using static`.
    /// A plain namespace import (`import Ns`) names no type and contributes
    /// nothing; an alias import (`import x = Ns.Type`) is a type alias, not
    /// a static import, and is likewise excluded (mirroring C#, where
    /// `using X = T;` does not hoist members). Same-compilation user types
    /// only; imported CLR static classes are out of scope (see ADR-0134).
    /// @returns The distinct imported static-import types, in import order. Empty when none apply.
    func GetStaticImportTypes() ImmutableArray[StructSymbol] {
        // Issue #1201: whether the fully-qualified import `target` names the user
        // type `s` — its package-qualified name (`PackageName.Name`), or its bare
        // simple name for a default-package type imported as `import TypeName`.
        let ImportTargetNamesType = func (target string, s StructSymbol) bool {
            if string.IsNullOrEmpty(target) || string.IsNullOrEmpty(s.Name) {
                return false
            }
            let pkg = s.PackageName
            let fq = if string.IsNullOrEmpty(pkg) || string.Equals(pkg, "Default", StringComparison.Ordinal) {
                s.Name
            } else {
                pkg + "." + s.Name
            }
            if string.Equals(fq, target, StringComparison.Ordinal) {
                return true
            }
            // A bare `import TypeName` (no dotted prefix) names a default-package type.
            return target.IndexOf('.') < 0 && string.Equals(s.Name, target, StringComparison.Ordinal)
        }
        let imports = RootScope.GetDeclaredImports()
        let structs = RootScope.GetDeclaredStructs()
        let services = Services
        if services.HasCachedStaticImportTypes && services.CachedStaticImportImports.SequenceEqual(imports) &&
            services
            .CachedStaticImportStructs
            .Equals(structs) && object.ReferenceEquals(
            services.CachedStaticImportSyntaxTree,
            RootScope.GetCurrentReferencingSyntaxTreeForCache()
        ) {
            return services.CachedStaticImportTypes
        }
        var builder ImmutableArray[StructSymbol].Builder? = nil
        var seen HashSet[StructSymbol]? = nil
        for imp in imports {
            // A compiler-synthesized (implicit `import System`) import always
            // names a namespace, and an alias import is a type alias rather than
            // a static import — neither hoists members.
            if imp.IsImplicit || imp.IsAlias {
                continue
            }
            for s in structs {
                if !ImportTargetNamesType(imp.Target, s) {
                    continue
                }
                seen ??= HashSet[StructSymbol]()
                if seen!!.Add(s) {
                    (
                        (
                            if builder == nil {
                                (builder = ImmutableArray.CreateBuilder[StructSymbol]())
                            } else {
                                builder
                            }
                        )!!
                    ).Add(s)
                }
                break
            }
        }
        let result = builder?.ToImmutable() ?? ImmutableArray[StructSymbol].Empty
        services.CachedStaticImportTypes = result
        services.HasCachedStaticImportTypes = true
        services.CachedStaticImportImports = imports
        services.CachedStaticImportStructs = structs
        services.CachedStaticImportSyntaxTree = RootScope.GetCurrentReferencingSyntaxTreeForCache()
        return result
    }

    /// ADR-0122 / issue #1014. Enters an `unsafe` context for the lifetime
    /// of the returned token (incrementing (cref:UnsafeDepth)); disposing
    /// the token leaves the context. When [`active`](paramref) is
    /// `false` the call is a no-op (the depth is unchanged), so
    /// callers can unconditionally wrap a region with the modifier's truthiness.
    /// @param active Whether to actually enter an unsafe context.
    /// @returns A disposable token that leaves the unsafe context when disposed.
    func PushUnsafeContext(active bool = true) UnsafeContextScope {
        if active {
            UnsafeDepth++
        }
        return UnsafeContextScope(this, active)
    }

    func BeginNarrowingProof(frame NarrowingFrame) {
        if narrowingProofGenerations.TryGetValue(frame, out var state) {
            narrowingProofGenerations[frame] = ((narrowingProofGeneration += 1), state.Depth + 1)
            return
        }
        narrowingProofGenerations.Add(frame, ((narrowingProofGeneration += 1), 1))
    }

    func EndNarrowingProof() {
        let index = NarrowedVariables.Count - 1
        let frame = NarrowedVariables[index]
        NarrowedVariables.RemoveAt(index)
        let state = narrowingProofGenerations[frame]
        if state.Depth == 1 {
            narrowingProofGenerations.Remove(frame)
        } else {
            narrowingProofGenerations[frame] = (state.Generation, state.Depth - 1)
        }
    }

    func GetNarrowingProofGeneration(frame NarrowingFrame) int32 -> if narrowingProofGenerations.TryGetValue(
        frame,
        out var state
    ) {
        state.Generation
    } else {
        0
    }

    /// Gets a value indicating whether a local or parameter named
    /// [`variable`](paramref) may be assigned by a closure of the
    /// enclosing function. The set is name based (a superset under shadowing)
    /// and computed once from the whole function syntax, so a closure bound
    /// later (reached through a backward edge) is still counted. Until it is
    /// computed the answer is `true` (fail-safe).
    /// @param variable The root variable.
    /// @returns `true` when a closure may assign it.
    func MayBeAssignedByClosure(variable VariableSymbol) bool -> !closureAssignedNamesComputed ||
        closureAssignedNames == nil ||
        closureAssignedNames!!.Contains(variable.Name)

    /// Records the names assigned inside any function literal or local function
    /// of the enclosing function, once, from [`computeNames`](paramref).
    /// @param computeNames Computes the assigned-name set.
    func EnsureClosureAssignedNames(computeNames() -> HashSet[string]?) {
        if closureAssignedNamesComputed {
            return
        }
        // A null set means any name may be assigned (fail-safe).
        closureAssignedNames = computeNames()
        closureAssignedNamesComputed = true
    }

    func TrackBackwardGotoNarrowingUse(
        variable VariableSymbol,
        location TextLocation,
        memberName string,
        kind BackwardGotoNarrowingUseKind,
        targetType TypeSymbol? = nil
    ) -> TrackBackwardGotoNarrowingUse(AccessPath.ForVariable(variable), location, memberName, kind, targetType)

    func TrackBackwardGotoNarrowingUse(
        path AccessPath,
        location TextLocation,
        memberName string,
        kind BackwardGotoNarrowingUseKind,
        targetType TypeSymbol? = nil,
        requiredType TypeSymbol? = nil
    ) {
        var frameIndex = -1
        for var i = NarrowedVariables.Count - 1; i >= 0; i-- {
            if NarrowedVariables[i].ContainsKey(path) {
                frameIndex = i
                break
            }
        }
        if frameIndex < 0 {
            return
        }
        let variable = path.Root
        let narrowedType = NarrowedVariables[frameIndex][path]
        let operationRequiredType = requiredType ?? narrowedType
        let access = BackwardGotoNarrowingAccess(
            path,
            location,
            memberName,
            kind,
            operationRequiredType,
            MemberLookup.GetDeclaredAccessPathType(path, narrowedType),
            targetType
        )
        for entry in BackwardGotoNarrowingStates {
            let state = entry.Value
            if !state
                .TargetSnapshot
                .NarrowingFrameIndices
                .TryGetValue(path, out var targetFrameIndex) ||
                frameIndex != targetFrameIndex ||
                !state
                .TargetSnapshot
                .NarrowingProofGenerations
                .TryGetValue(path, out var targetProof) ||
                GetNarrowingProofGeneration(NarrowedVariables[frameIndex]) != targetProof ||
                (
                !path.HasMembers && AssignmentNarrowingGenerations.TryGetValue(
                    variable,
                    out var assignmentGeneration
                ) &&
                    (
                    !state
                        .TargetSnapshot
                        .AssignmentGenerations
                        .TryGetValue(variable, out var targetAssignmentGeneration) ||
                        assignmentGeneration > targetAssignmentGeneration
                )
            ) {
                continue
            }
            state.Accesses.Add(access)
            for edge in state.Edges {
                edge.Accesses.Add(access)
            }
            if state.UpstreamLabels.TryGetValue(path, out var upstreamLabels) {
                for upstreamLabel in upstreamLabels {
                    let upstreamState = BackwardGotoNarrowingStates[upstreamLabel]
                    upstreamState.Accesses.Add(access)
                    for edge in upstreamState.Edges {
                        edge.Accesses.Add(access)
                    }
                }
            }
        }
    }

    func TrackBackwardGotoNarrowingRead(variable VariableSymbol, location TextLocation) {
        let narrowedType = NarrowedVariables.Query(AccessPath.ForVariable(variable))
        if narrowedType == nil || !NarrowedReadChangesRuntimeType(variable.Type, narrowedType) {
            return
        }
        TrackBackwardGotoNarrowingUse(
            variable,
            location,
            string.Empty,
            BackwardGotoNarrowingUseKind.Conversion,
            narrowedType
        )
    }

    func UntrackBackwardGotoNarrowingIndex(
        variable VariableSymbol,
        location TextLocation
    ) -> UntrackBackwardGotoNarrowingUse(
        AccessPath.ForVariable(variable),
        location,
        BackwardGotoNarrowingUseKind.Conversion,
        BackwardGotoNarrowingUseKind.Index
    )

    func UntrackBackwardGotoNarrowingIndexUse(
        variable VariableSymbol,
        location TextLocation
    ) -> UntrackBackwardGotoNarrowingUse(AccessPath.ForVariable(variable), location, BackwardGotoNarrowingUseKind.Index)

    func UntrackBackwardGotoNarrowingMemberUse(
        path AccessPath,
        location TextLocation
    ) -> UntrackBackwardGotoNarrowingUse(path, location, BackwardGotoNarrowingUseKind.Member)

    func UntrackBackwardGotoNarrowingConversion(
        path AccessPath,
        location TextLocation
    ) -> UntrackBackwardGotoNarrowingUse(path, location, BackwardGotoNarrowingUseKind.Conversion)

    func UntrackBackwardGotoNarrowingUse(
        path AccessPath,
        location TextLocation,
        kinds ...BackwardGotoNarrowingUseKind
    ) {
        let IsWithin = func (candidate TextLocation, container TextLocation) bool {
            return object.ReferenceEquals(candidate.Text, container.Text) &&
                candidate
                .Span
                .Start >= container
                .Span
                .Start &&
                candidate
                .Span
                .End <= container
                .Span
                .End
        }
        for state in BackwardGotoNarrowingStates.Values {
            state.Accesses.RemoveAll(
                (access BackwardGotoNarrowingAccess) -> access.Path.Equals(path) &&
                    IsWithin(access.Location, location) &&
                    kinds.Contains(access.Kind)
            )
            for edge in state.Edges {
                edge.Accesses.RemoveAll(
                    (access BackwardGotoNarrowingAccess) -> access.Path.Equals(path) &&
                        IsWithin(access.Location, location) &&
                        kinds.Contains(access.Kind)
                )
            }
        }
    }

    func TryGetBackwardGotoNarrowingPath(
        expression BoundExpression,
        @NotNullWhen(true) out path AccessPath?,
        @NotNullWhen(true) out narrowedType TypeSymbol?
    ) bool {
        if expression is BoundVariableExpression{NarrowedType: {} variableNarrowed} variableRead {
            path = AccessPath.ForVariable(variableRead.Variable)
            narrowedType = variableNarrowed
            return true
        }
        // A write to an out parameter or a call drops the narrowing of the others (ADR-0208 R12), so
        // the loop reads a local copy.
        let found = SmartCastStability.TryGetStableMemberPath(expression, out path, out _)
        let stablePath = path
        if !found || stablePath == nil {
            narrowedType = nil
            return false
        }
        narrowedType = NarrowedVariables.Query(stablePath)
        return narrowedType != nil
    }

    /// Records a narrowed variable consumed at a non-null boundary, then
    /// applies the ordinary platform-type coercion.
    /// @param expression The value crossing the boundary.
    /// @param location The source location of the use.
    /// @param boundary The platform-check boundary description.
    /// @param suppressible Whether platform-check suppression applies.
    /// @returns The checked or unchanged expression.
    func InsertPlatformCheck(
        expression BoundExpression,
        location TextLocation?,
        boundary string,
        suppressible bool = true
    ) BoundExpression {
        if location is {} useLocation &&
            TryGetBackwardGotoNarrowingPath(expression, out var path, out var narrowedType) &&
            (
            Invariant.Required(path, "a narrowed boundary has an access path", expression: "path")
                .HasMembers ||
                !NarrowedReadChangesRuntimeType(
                path!!.Root.Type,
                Invariant.Required(narrowedType, "a narrowed boundary has a narrowed type", expression: "narrowedType")
            )
        ) {
            TrackBackwardGotoNarrowingUse(
                path!!,
                useLocation,
                string.Empty,
                BackwardGotoNarrowingUseKind.NonNullUse,
                expression.Type
            )
        }
        return PlatformCoercion.InsertCheck(expression, location, boundary, suppressible)
    }

    /// Enters a base or delegating-constructor argument context.
    /// @returns A token that leaves the context when disposed.
    func PushConstructorInitializerContext() ConstructorInitializerContextScope {
        ConstructorInitializerDepth++
        return ConstructorInitializerContextScope(this)
    }

    /// Leaves a base or delegating-constructor argument context.
    func LeaveConstructorInitializerContext() {
        ConstructorInitializerDepth--
    }

    /// Issue #1881. Enters a `checked`/`unchecked` arithmetic context for the
    /// lifetime of the returned token; disposing the token restores the
    /// previous context (innermost nesting wins).
    /// @param isChecked Whether the entered context is checked (true) or unchecked (false).
    /// @returns A disposable token that restores the previous context when disposed.
    func PushCheckedContext(isChecked bool) CheckedContextScope {
        let previous = IsCheckedContext
        IsCheckedContext = isChecked
        return CheckedContextScope(this, previous)
    }

    /// The ambient context a channel operation should observe here, or
    /// `null` when no `scope` encloses this position
    /// (ADR-0174 D7).
    /// @returns A read of the innermost scope's `ctx`, or `null`.
    func AmbientContext() BoundExpression? -> if ScopeContexts.Count > 0 {
        BoundVariableExpression(nil, ScopeContexts.Peek())
    } else {
        default(BoundVariableExpression?)
    }

    /// Disposable token returned by (cref:PushUnsafeContext) that
    /// decrements (cref:UnsafeDepth) on disposal (ADR-0122 / issue #1014).
    struct UnsafeContextScope : IDisposable {
        private let owner BinderContext
        private let active bool

        internal init(owner BinderContext, active bool) {
            this.owner = owner
            this.active = active
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        func Dispose() {
            if active {
                owner.UnsafeDepth--
            }
        }
    }

    /// Disposable token returned by (cref:PushConstructorInitializerContext).
    struct ConstructorInitializerContextScope : IDisposable {
        private let owner BinderContext?

        internal init(owner BinderContext) {
            this.owner = owner
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        func Dispose() {
            if owner != nil {
                owner!!.LeaveConstructorInitializerContext()
            }
        }
    }

    /// Disposable token returned by (cref:PushCheckedContext) that
    /// restores the enclosing checked/unchecked context on disposal (issue #1881).
    struct CheckedContextScope : IDisposable {
        private let owner BinderContext?
        private let previous bool

        internal init(owner BinderContext, previous bool) {
            this.owner = owner
            this.previous = previous
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        func Dispose() {
            if owner != nil {
                this.owner.IsCheckedContext = previous
            }
        }
    }

    shared {
        func ClrTypeExposesStaticMember(type Type?, name string) bool {
            if type == nil {
                return false
            }
            const flags = BindingFlags.Static | BindingFlags.Public
            return ClrTypeUtilities.SafeGetMethods(type, flags).Any(
                (member MethodInfo) -> ClrTypeUtilities.EmittedMemberNameMatches(member, name)
            ) ||
                ClrTypeUtilities
                .SafeGetProperties(type, flags).Any(
                (member PropertyInfo) -> ClrTypeUtilities.EmittedMemberNameMatches(member, name)
            ) ||
                ClrTypeUtilities
                .SafeGetFields(type, flags).Any(
                (member FieldInfo) -> ClrTypeUtilities.EmittedMemberNameMatches(member, name)
            )
        }

        func ImportedTypeExposesStaticMember(
            type StructSymbol,
            name string
        ) bool -> TypeMemberModel.TryGetStaticFieldIncludingInherited(type, name, out _, out _) ||
            TypeMemberModel.TryGetStaticPropertyIncludingInherited(type, name, out _, out _) ||
            !TypeMemberModel
            .GetMethods(type, name, MemberQuery.InheritedStatic(MemberKinds.Method)).IsDefaultOrEmpty

        func NarrowedReadChangesRuntimeType(declaredType TypeSymbol, narrowedType TypeSymbol) bool {
            if declaredType == narrowedType {
                return false
            }
            if declaredType is NullableTypeSymbol nullable && nullable.UnderlyingType == narrowedType {
                return NullableLifting.IsValueTypeNullable(nullable) || NullableLifting.IsUserValueTypeNullable(
                    nullable
                )
            }
            return declaredType.ClrType == nil ||
                narrowedType.ClrType == nil ||
                declaredType.ClrType != narrowedType.ClrType
        }
    }
}
