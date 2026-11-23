// <copyright file="RefInitializationHoister.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// Lowering pass that eliminates `ref` locals (managed pointer locals) from
/// async method bodies so they do not require hoisting into byref fields — which
/// the CLR forbids on heap-allocated or state-machine types.
/// @remarks A ref local is identified by its type being (cref:ByRefTypeSymbol)
/// and its initializer or re-seat values deriving from addressable storage.
/// The hoister recomputes the managed pointer at every use site:
///
/// - `*refLocal` (dereference read) → replaced with the underlying lvalue expression.
/// - `refLocal` (bare pointer usage, e.g., passed to ref parameter) → replaced with `&lvalue`.
///
/// When a ref local is re-seated across an `await` or `yield`, each definition
/// site captures its own operand components into temporaries and writes a
/// deterministic slot index to a hoisted `int32` tag local. Every use site
/// dispatches on that tag via (cref:BoundConditionalAddressExpression) so only
/// dynamically executed re-seats take effect. Re-seated ref locals that never
/// cross a suspension point remain plain `MoveNext` locals.
///
/// To avoid duplicating side effects (issue #418 / P1-12), any
/// non-trivial sub-expression of the original ref initializer (call receiver,
/// index expression, etc.) is evaluated <em>once</em> into a hoisted temporary
/// local at the ref-initialization site. The reconstructed lvalue then refers
/// only to those temporaries and other side-effect-free leaves (variables,
/// parameters, literals), making it safe to inline at every use site. The
/// constituent variables are themselves later hoisted into state-machine
/// fields by (cref:AsyncCaptureWalker) if they cross an await.
///
/// A reconstructed field or element address is also probed once at the
/// original declaration or re-seat site. This preserves null and bounds
/// exceptions before a later suspension while still avoiding an illegal
/// managed-pointer state-machine field.
///
/// This pass runs after (cref:SpillSequenceSpiller) and before
/// (cref:AsyncStateMachineTypeBuilder) in the async pipeline.
/// Opaque borrowed addresses remain MoveNext locals only when the shared
/// suspension-liveness analysis proves they do not cross a suspension.
shared class RefInitializationHoister {
    private class RefLocalInfo {
        init(local LocalVariableSymbol, tagLocal LocalVariableSymbol?, isSingleAddressInit bool) {
            Local = local
            TagLocal = tagLocal
            IsSingleAddressInit = isSingleAddressInit
            Templates = List[BoundExpression]()
            SiteComponents = List[List[LocalVariableSymbol]]()
        }

        prop Local LocalVariableSymbol {
            get;
        }

        prop TagLocal LocalVariableSymbol? {
            get;
        }

        prop IsSingleAddressInit bool {
            get;
        }

        prop Templates List[BoundExpression] {
            get;
        }

        prop SiteComponents List[List[LocalVariableSymbol]] {
            get;
        }

        func BuildAddressExpression(syntax SyntaxNode?) BoundExpression {
            if Templates.Count == 1 {
                return Templates[0]
            }
            if Templates.Count == 0 || TagLocal == nil {
                throw System.InvalidOperationException(
                    "Cannot reconstruct address for ref local '${Local.Name}' with no active template."
                )
            }
            return BuildConditionalDispatch(TagLocal, Templates, RefInitializationHoister.GetPointeeType(Local))
        }

        func BuildDereferenceExpression(syntax SyntaxNode?) BoundExpression {
            if Templates.Count == 1 {
                let template = Templates[0]
                if template is BoundAddressOfExpression address {
                    return address.Operand
                }
                if template is BoundConditionalAddressExpression condAddr {
                    return BoundDereferenceExpression(syntax, condAddr)
                }
                if template is BoundDefaultExpression {
                    return BoundDereferenceExpression(syntax, template)
                }
            }
            return BoundDereferenceExpression(syntax, BuildAddressExpression(syntax))
        }

        shared {
            internal func ToAddressOperand(template BoundExpression) BoundExpression {
                if template is BoundAddressOfExpression address {
                    return address.Operand
                }
                if template is BoundConditionalAddressExpression condAddr {
                    return BoundDereferenceExpression(nil, condAddr)
                }
                if template is BoundDefaultExpression {
                    return BoundDereferenceExpression(nil, template)
                }
                throw System.InvalidOperationException("Unexpected ref local template kind '${template.Kind}'.")
            }

            private func BuildConditionalDispatch(
                tagLocal LocalVariableSymbol,
                templates List[BoundExpression],
                pointeeType TypeSymbol
            ) BoundConditionalAddressExpression {
                let equalsOp = Invariant.Required(
                    BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                    "int32 equality operator exists for ref slot dispatch",
                    expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                )
                var current = ToAddressOperand(templates[0])
                for var i = 1; i < templates.Count; i++ {
                    let condition = BoundBinaryExpression(
                        nil,
                        BoundVariableExpression(nil, tagLocal),
                        equalsOp,
                        BoundLiteralExpression(nil, i)
                    )
                    let condAddr = BoundConditionalAddressExpression(
                        nil,
                        condition,
                        ToAddressOperand(templates[i]),
                        current,
                        pointeeType
                    )
                    if i == templates.Count - 1 {
                        return condAddr
                    }
                    current = BoundDereferenceExpression(nil, condAddr)
                }
                throw System.InvalidOperationException("Expected at least two templates for conditional dispatch.")
            }
        }
    }

    private class Collector : BoundTreeWalker {
        private let seen HashSet[LocalVariableSymbol] = HashSet[LocalVariableSymbol]()
        private var blockExpressionDepth int32

        init() {
            OrderedLocals = List[LocalVariableSymbol]()
            StatementLocals = List[LocalVariableSymbol]()
            Declarations = Dictionary[LocalVariableSymbol, BoundVariableDeclaration]()
            StatementDeclarations = HashSet[LocalVariableSymbol]()
            AssignmentCounts = Dictionary[LocalVariableSymbol, int32]()
            Dependencies = Dictionary[LocalVariableSymbol, HashSet[LocalVariableSymbol]]()
            OpaqueLocals = HashSet[LocalVariableSymbol]()
        }

        prop OrderedLocals List[LocalVariableSymbol] {
            get;
        }
        prop StatementLocals List[LocalVariableSymbol] {
            get;
        }
        prop Declarations Dictionary[LocalVariableSymbol, BoundVariableDeclaration] {
            get;
        }
        prop StatementDeclarations HashSet[LocalVariableSymbol] {
            get;
        }
        prop AssignmentCounts Dictionary[LocalVariableSymbol, int32] {
            get;
        }
        prop Dependencies Dictionary[LocalVariableSymbol, HashSet[LocalVariableSymbol]] {
            get;
        }
        prop OpaqueLocals HashSet[LocalVariableSymbol] {
            get;
        }

        protected override func VisitBlockExpression(node BoundBlockExpression) {
            blockExpressionDepth++
            try {
                base.VisitBlockExpression(node)
            } finally {
                blockExpressionDepth--
            }
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            // Track all ByRefTypeSymbol declarations so block-result aliases can
            // be transitively lowered when an outer crossing local depends on
            // them, while StatementDeclarations/StatementLocals keep
            // compiler-generated BoundBlockExpression temporaries out of the
            // initial rewrite seed and suspension-liveness set.
            if node.Variable is LocalVariableSymbol local &&
                (local.Type is ByRefTypeSymbol || local.RefKind != RefKind.None) {
                if seen.Add(local) {
                    OrderedLocals.Add(local)
                }
                Declarations[local] = node
                if blockExpressionDepth == 0 && StatementDeclarations.Add(local) {
                    StatementLocals.Add(local)
                }
                if let initializer = node.Initializer {
                    CollectDependencies(local, initializer)
                    if RefInitializationHoister.ContainsOpaqueStorage(initializer) {
                        OpaqueLocals.Add(local)
                    }
                }
            }
            base.VisitVariableDeclaration(node)
        }

        protected override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            if node.Variable is LocalVariableSymbol local &&
                local.Type is ByRefTypeSymbol &&
                local.RefKind == RefKind.None {
                if seen.Add(local) {
                    OrderedLocals.Add(local)
                }
                AssignmentCounts.TryGetValue(local, out var count)
                AssignmentCounts[local] = count + 1
                CollectDependencies(local, node.Expression)
                if RefInitializationHoister.ContainsOpaqueStorage(node.Expression) {
                    OpaqueLocals.Add(local)
                }
            }
            base.VisitAssignmentExpression(node)
        }

        private func CollectDependencies(target LocalVariableSymbol, expression BoundExpression) {
            let walker = DependencyWalker(target, Dependencies)
            walker.Visit(expression)
        }

        private class DependencyWalker : BoundTreeWalker {
            private let target LocalVariableSymbol
            private let dependencies Dictionary[LocalVariableSymbol, HashSet[LocalVariableSymbol]]
            private var inStorageContext bool

            init(
                target LocalVariableSymbol,
                dependencies Dictionary[LocalVariableSymbol, HashSet[LocalVariableSymbol]]
            ) {
                this.target = target
                this.dependencies = dependencies
                this.inStorageContext = true
            }

            private func RecordStorageDependency(variable VariableSymbol?) {
                if variable is LocalVariableSymbol other &&
                    (other.Type is ByRefTypeSymbol || other.RefKind != RefKind.None) &&
                    !object.ReferenceEquals(other, target) {
                    if !dependencies.TryGetValue(target, out var set) {
                        set = HashSet[LocalVariableSymbol]()
                        dependencies[target] = set
                    }
                    set.Add(other)
                }
            }

            private func VisitValueChild(expr BoundExpression?) {
                if expr == nil {
                    return
                }
                let previous = inStorageContext
                inStorageContext = false
                try {
                    VisitExpression(expr)
                } finally {
                    inStorageContext = previous
                }
            }

            private func VisitReceiverChild(receiver BoundExpression?) {
                if receiver == nil {
                    return
                }
                if Binder.IsReferenceTypeForConstraint(receiver.Type) {
                    VisitValueChild(receiver)
                    return
                }
                if receiver is BoundVariableExpression{Variable: LocalVariableSymbol refAlias} &&
                    inStorageContext &&
                    refAlias.RefKind != RefKind.None {
                    RecordStorageDependency(refAlias)
                } else {
                    VisitExpression(receiver)
                }
            }

            override func VisitExpression(node BoundExpression?) {
                if node == nil || node is BoundFunctionLiteralExpression {
                    return
                }
                if node is BoundVariableExpression varExpr &&
                    inStorageContext &&
                    varExpr.Variable is LocalVariableSymbol other &&
                    other.Type is ByRefTypeSymbol {
                    RecordStorageDependency(other)
                }
                switch node {
                    case addr is BoundAddressOfExpression {
                        let previous = inStorageContext
                        inStorageContext = !addr.IsUnmanaged
                        try {
                            if addr.Operand is BoundVariableExpression{Variable: LocalVariableSymbol refAlias} &&
                                !addr.IsUnmanaged &&
                                refAlias.RefKind != RefKind.None {
                                RecordStorageDependency(refAlias)
                            } else {
                                VisitExpression(addr.Operand)
                            }
                        } finally {
                            inStorageContext = previous
                        }
                    }
                    case deref is BoundDereferenceExpression {
                        if deref.Operand is BoundVariableExpression{Variable: LocalVariableSymbol ptr} &&
                            ptr.Type is ByRefTypeSymbol {
                            if inStorageContext {
                                RecordStorageDependency(ptr)
                            }
                            return
                        }
                        base.VisitExpression(node)
                    }
                    case block is BoundBlockExpression {
                        for stmt in block.Statements {
                            let previous = inStorageContext
                            inStorageContext = false
                            try {
                                VisitStatement(stmt)
                            } finally {
                                inStorageContext = previous
                            }
                        }
                        VisitExpression(block.Expression)
                    }
                    case cond is BoundConditionalExpression {
                        VisitValueChild(cond.Condition)
                        VisitExpression(cond.WhenTrue)
                        VisitExpression(cond.WhenFalse)
                    }
                    case condAddr is BoundConditionalAddressExpression {
                        VisitValueChild(condAddr.Condition)
                        VisitExpression(condAddr.WhenTrueOperand)
                        VisitExpression(condAddr.WhenFalseOperand)
                    }
                    case idx is BoundIndexExpression {
                        VisitValueChild(idx.Target)
                        for index in idx.Indices {
                            VisitValueChild(index)
                        }
                    }
                    case clrIdx is BoundClrIndexExpression {
                        if SideEffectSpiller.IsInPlaceStorageWriteReceiver(clrIdx.Target) {
                            VisitReceiverChild(clrIdx.Target)
                        } else {
                            VisitValueChild(clrIdx.Target)
                        }
                        for arg in clrIdx.Arguments {
                            VisitValueChild(arg)
                        }
                    }
                    case field is BoundFieldAccessExpression {
                        VisitReceiverChild(field.Receiver)
                    }
                    case tuple is BoundTupleElementAccessExpression {
                        VisitReceiverChild(tuple.Receiver)
                    }
                    case clrProp is BoundClrPropertyAccessExpression {
                        if clrProp.Member is FieldInfo {
                            VisitReceiverChild(clrProp.Receiver)
                        } else {
                            VisitValueChild(clrProp.Receiver)
                        }
                    }
                    case _ is BoundAssignmentExpression {
                        base.VisitExpression(node)
                    }
                    default {
                        let previous = inStorageContext
                        inStorageContext = false
                        try {
                            base.VisitExpression(node)
                        } finally {
                            inStorageContext = previous
                        }
                    }
                }
            }

            protected override func VisitAssignmentExpression(node BoundAssignmentExpression) {
                if inStorageContext {
                    RecordStorageDependency(node.Variable)
                }
                base.VisitAssignmentExpression(node)
            }
        }
    }

    private class SharedSite {
        init(owner LocalVariableSymbol, template BoundExpression, components List[LocalVariableSymbol]) {
            Owner = owner
            Template = template
            Components = components
        }

        prop Owner LocalVariableSymbol {
            get;
        }

        prop Template BoundExpression {
            get;
        }

        prop Components List[LocalVariableSymbol] {
            get;
        }
    }

    private class VariableSubstituter : BoundTreeRewriter {
        private let substitutions Dictionary[VariableSymbol, LocalVariableSymbol]

        init(substitutions Dictionary[VariableSymbol, LocalVariableSymbol]) {
            this.substitutions = substitutions
        }

        func Rewrite(expression BoundExpression) BoundExpression -> RewriteExpression(expression)

        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
            if substitutions.TryGetValue(node.Variable, out var replacement) {
                return BoundVariableExpression(node.Syntax, replacement, node.NarrowedType)
            }
            return node
        }
    }

    private class DefinitionRewriter : BoundTreeRewriter {
        private let refLocals Dictionary[LocalVariableSymbol, RefLocalInfo]
        private let crossing HashSet[VariableSymbol]
        private let assignmentCounts Dictionary[LocalVariableSymbol, int32]
        private var tempCounter int32
        private let activeDeclarations List[BoundStatement] = List[BoundStatement]()
        private let deferredCopies HashSet[BoundAssignmentExpression] = HashSet[BoundAssignmentExpression]()
        private let sharedSites List[SharedSite]?
        private var stagedTemps List[LocalVariableSymbol]? = nil

        init(
            refLocals Dictionary[LocalVariableSymbol, RefLocalInfo],
            crossing HashSet[VariableSymbol],
            assignmentCounts Dictionary[LocalVariableSymbol, int32],
            initialTempCounter int32,
            sharedSites List[SharedSite]? = nil
        ) {
            this.refLocals = refLocals
            this.crossing = crossing
            this.assignmentCounts = assignmentCounts
            this.tempCounter = initialTempCounter
            this.sharedSites = sharedSites
        }

        prop TempCounter int32 -> tempCounter
        prop ActiveDeclarations IReadOnlyList[BoundStatement] -> activeDeclarations
        prop DeferredCopies HashSet[BoundAssignmentExpression] -> deferredCopies

        protected override func RewriteBlockExpression(node BoundBlockExpression) BoundExpression {
            var statementBuilder ImmutableArray[BoundStatement].Builder? = nil
            for var i = 0; i < node.Statements.Length; i++ {
                let oldStatement = node.Statements[i]
                let newStatement = RewriteStatement(oldStatement)
                if newStatement != oldStatement && statementBuilder == nil {
                    statementBuilder = ImmutableArray.CreateBuilder[BoundStatement](node.Statements.Length)
                    for var j = 0; j < i; j++ {
                        statementBuilder.Add(node.Statements[j])
                    }
                }
                if statementBuilder != nil {
                    if newStatement is BoundBlockStatement block {
                        statementBuilder.AddRange(block.Statements)
                    } else {
                        statementBuilder.Add(newStatement)
                    }
                }
            }
            let expression = RewriteExpression(node.Expression)
            if statementBuilder == nil && expression == node.Expression {
                return node
            }
            return BoundBlockExpression(node.Syntax, statementBuilder?.ToImmutable() ?? node.Statements, expression)
        }

        protected override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
            // Replace ref local declarations with component captures plus any
            // required field/element address probe. The rewritten template —
            // referencing only captured temps and repeatable storage — is
            // recorded for use-site reconstruction.
            let local = node.Variable as LocalVariableSymbol
            if local != nil &&
                (local.Type is ByRefTypeSymbol || local.RefKind != RefKind.None) &&
                refLocals.TryGetValue(local, out var info) {
                return RewriteTrackedVariableDeclaration(node, local, info)
            }
            return base.RewriteVariableDeclaration(node)
        }

        private func RewriteTrackedVariableDeclaration(
            node BoundVariableDeclaration,
            local LocalVariableSymbol,
            info RefLocalInfo
        ) BoundStatement {
            let prelude = ImmutableArray.CreateBuilder[BoundStatement]()
            if info.IsSingleAddressInit {
                let addressOf = cast[BoundAddressOfExpression](node.Initializer!!)
                let template = HoistOperand(addressOf.Operand, prelude, captureComponents: true)
                let rebuiltAddress = addressOf.Update(template)
                // A reference used without suspension must retain its definition-time address effects.
                let preserveDefinitionEffects = !crossing.Contains(local) &&
                    !OverloadResolver.CanDeferAddressEvaluation(rebuiltAddress)
                if preserveDefinitionEffects || ShouldProbeTemplate(template) {
                    prelude.Add(BoundExpressionStatement(node.Syntax, rebuiltAddress))
                }
                info.Templates.Add(rebuiltAddress)
                return BoundBlockStatement(nil, prelude.ToImmutable())
            }
            if node.Initializer is BoundDefaultExpression {
                let nullTemplate = BoundDefaultExpression(nil, local.Type)
                let slotId = AddConcreteSite(local, info, nullTemplate, List[LocalVariableSymbol]())
                if info.TagLocal != nil {
                    prelude.Add(BoundVariableDeclaration(nil, info.TagLocal, BoundLiteralExpression(nil, slotId)))
                }
                return BoundBlockStatement(nil, prelude.ToImmutable())
            }
            if sharedSites != nil && TryGetSharedSourceTag(info, node.Initializer!!, out _) {
                // Defer peer alias copies to CopyRewriter once all shared sites
                // and their per-local component slots are materialized.
                return node
            }
            if RequiresBranchLowering(info, local, node.Initializer!!) {
                if info.TagLocal != nil {
                    prelude.Add(BoundVariableDeclaration(nil, info.TagLocal, BoundLiteralExpression(nil, -1)))
                }
                EmitAssignmentStatements(local, info, node.Initializer!!, node.Syntax, prelude, out _)
                return BoundBlockStatement(nil, prelude.ToImmutable())
            }
            let siteComponents = List[LocalVariableSymbol]()
            let rebuiltTemplate = HoistAddressTemplate(
                local,
                node.Initializer!!,
                prelude,
                node.Syntax,
                preserveEffects: !crossing.Contains(local),
                stageComponents: sharedSites != nil,
                siteComponents
            )
            let slotId = AddConcreteSite(local, info, rebuiltTemplate, siteComponents)
            if info.TagLocal != nil {
                prelude.Add(BoundVariableDeclaration(nil, info.TagLocal, BoundLiteralExpression(nil, slotId)))
            }
            return BoundBlockStatement(nil, prelude.ToImmutable())
        }

        protected override func RewriteExpressionStatement(node BoundExpressionStatement) BoundStatement {
            if node.Expression is BoundAssignmentExpression assign &&
                assign.Variable is LocalVariableSymbol local &&
                local.RefKind == RefKind.None &&
                refLocals.TryGetValue(local, out var info) {
                if IsSelfVariable(assign.Expression, local) {
                    return BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
                }
                if sharedSites != nil && TryGetSharedSourceTag(info, assign.Expression, out _) {
                    return node
                }
                let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                EmitAssignmentStatements(local, info, assign.Expression, node.Syntax, statements, out _)
                return if statements.Count == 1 {
                    statements[0]
                } else {
                    cast[BoundStatement](BoundBlockStatement(nil, statements.ToImmutable()))
                }
            }
            return base.RewriteExpressionStatement(node)
        }

        protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
            if node.Variable is LocalVariableSymbol local && local.RefKind == RefKind.None && refLocals.TryGetValue(
                local,
                out var info
            ) {
                if IsSelfVariable(node.Expression, local) {
                    return BoundVariableExpression(node.Syntax, local)
                }
                if sharedSites != nil && TryGetSharedSourceTag(info, node.Expression, out _) {
                    return node
                }
                let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                EmitAssignmentStatements(local, info, node.Expression, node.Syntax, statements, out var rebuiltTemplate)
                return BoundBlockExpression(
                    node.Syntax,
                    statements.ToImmutable(),
                    rebuiltTemplate ?? BoundVariableExpression(node.Syntax, local)
                )
            }
            return base.RewriteAssignmentExpression(node)
        }

        private func AddConcreteSite(
            owner LocalVariableSymbol,
            info RefLocalInfo,
            template BoundExpression,
            components List[LocalVariableSymbol]
        ) int32 {
            if sharedSites != nil {
                let slotId = sharedSites.Count
                sharedSites.Add(SharedSite(owner, template, components))
                return slotId
            }
            let slotId = info.Templates.Count
            info.Templates.Add(template)
            info.SiteComponents.Add(components)
            return slotId
        }

        private func EmitAssignmentStatements(
            local LocalVariableSymbol,
            info RefLocalInfo,
            rhs BoundExpression,
            syntax SyntaxNode?,
            statements ImmutableArray[BoundStatement].Builder,
            out rebuiltTemplate BoundExpression?
        ) {
            let unwrapped = RefInitializationHoister.UnwrapManagedAddressOfDeref(rhs)
            if !object.ReferenceEquals(unwrapped, rhs) &&
                !(
                unwrapped is BoundVariableExpression{Variable: LocalVariableSymbol unwrappedLocal} &&
                    unwrappedLocal.RefKind != RefKind.None &&
                    !IsSelfVariable(unwrapped, local) &&
                    !(sharedSites != nil && TryGetSharedSourceTag(info, unwrapped, out _))
            ) {
                EmitAssignmentStatements(local, info, unwrapped, syntax, statements, out rebuiltTemplate)
                return
            }
            if IsSelfVariable(rhs, local) {
                rebuiltTemplate = nil
                return
            }
            if sharedSites != nil && TryGetSharedSourceTag(info, rhs, out _) {
                let deferredCopy = BoundAssignmentExpression(nil, local, rhs)
                deferredCopies.Add(deferredCopy)
                statements.Add(BoundExpressionStatement(syntax, deferredCopy))
                rebuiltTemplate = nil
                return
            }
            if IsNonCompletingExpression(rhs) {
                EmitNonCompletingExpression(rhs, statements)
                rebuiltTemplate = nil
                return
            }
            if rhs is BoundAssignmentExpression nestedAssign &&
                nestedAssign.Variable is LocalVariableSymbol innerLocal &&
                innerLocal.RefKind == RefKind.None &&
                innerLocal.Type is ByRefTypeSymbol {
                let rewrittenInner = RewriteAssignmentExpression(nestedAssign)
                if rewrittenInner is BoundBlockExpression innerBlock {
                    statements.AddRange(innerBlock.Statements)
                    EmitAssignmentStatements(
                        local,
                        info,
                        innerBlock.Expression,
                        syntax,
                        statements,
                        out rebuiltTemplate
                    )
                    return
                }
                if rewrittenInner is not BoundVariableExpression {
                    statements.Add(BoundExpressionStatement(syntax, rewrittenInner))
                }
                EmitAssignmentStatements(
                    local,
                    info,
                    BoundVariableExpression(nestedAssign.Syntax, innerLocal),
                    syntax,
                    statements,
                    out rebuiltTemplate
                )
                return
            }
            if rhs is BoundBlockExpression block && RequiresBranchLowering(info, local, block.Expression) {
                for stmt in block.Statements {
                    let rewritten = RewriteStatement(stmt)
                    if rewritten is BoundBlockStatement nested {
                        statements.AddRange(nested.Statements)
                    } else {
                        statements.Add(rewritten)
                    }
                }
                EmitAssignmentStatements(local, info, block.Expression, syntax, statements, out rebuiltTemplate)
                return
            }
            if rhs is BoundAddressOfExpression{IsUnmanaged: false, Operand: BoundBlockExpression block} addrBlock &&
                RequiresBranchLowering(info, local, addrBlock) {
                for stmt in block.Statements {
                    let rewritten = RewriteStatement(stmt)
                    if rewritten is BoundBlockStatement nested {
                        statements.AddRange(nested.Statements)
                    } else {
                        statements.Add(rewritten)
                    }
                }
                EmitAssignmentStatements(
                    local,
                    info,
                    BoundAddressOfExpression(addrBlock.Syntax, block.Expression),
                    syntax,
                    statements,
                    out rebuiltTemplate
                )
                return
            }
            if rhs is BoundAddressOfExpression{IsUnmanaged: false, Operand: BoundConditionalExpression cond} addrCond &&
                RequiresBranchLowering(info, local, addrCond) {
                let asCondExpr = BoundConditionalExpression(
                    cond.Syntax,
                    cond.Condition,
                    BoundAddressOfExpression(addrCond.Syntax, cond.WhenTrue),
                    BoundAddressOfExpression(addrCond.Syntax, cond.WhenFalse),
                    addrCond.Type
                )
                EmitAssignmentStatements(local, info, asCondExpr, syntax, statements, out rebuiltTemplate)
                return
            }
            if rhs is BoundConditionalAddressExpression condAddr && RequiresBranchLowering(info, local, condAddr) {
                let asCondExpr = BoundConditionalExpression(
                    condAddr.Syntax,
                    condAddr.Condition,
                    BoundAddressOfExpression(condAddr.Syntax, condAddr.WhenTrueOperand),
                    BoundAddressOfExpression(condAddr.Syntax, condAddr.WhenFalseOperand),
                    condAddr.Type
                )
                EmitAssignmentStatements(local, info, asCondExpr, syntax, statements, out rebuiltTemplate)
                return
            }
            if rhs is BoundConditionalExpression condExpr &&
                (
                RequiresBranchLowering(info, local, condExpr.WhenTrue) ||
                    RequiresBranchLowering(info, local, condExpr.WhenFalse)
            ) {
                let cond = RewriteExpression(condExpr.Condition)
                let trueIsSelf = IsSelfVariable(condExpr.WhenTrue, local)
                let falseIsSelf = IsSelfVariable(condExpr.WhenFalse, local)
                if trueIsSelf && falseIsSelf {
                    if !RefInitializationHoister.IsTriviallyRepeatable(cond) {
                        statements.Add(BoundExpressionStatement(syntax, cond))
                    }
                    rebuiltTemplate = nil
                    return
                }
                if trueIsSelf || falseIsSelf {
                    let keepTrue = !trueIsSelf
                    let chosenArm = if keepTrue {
                        condExpr.WhenTrue
                    } else {
                        condExpr.WhenFalse
                    }
                    let branchPrelude = ImmutableArray.CreateBuilder[BoundStatement]()
                    EmitAssignmentStatements(local, info, chosenArm, syntax, branchPrelude, out _)
                    let skip = BoundLabel("<refSkip>__${tempCounter++}")
                    statements.Add(BoundConditionalGotoStatement(nil, skip, cond, jumpIfTrue: !keepTrue))
                    statements.AddRange(branchPrelude)
                    statements.Add(BoundLabelStatement(nil, skip))
                    rebuiltTemplate = nil
                    return
                }
                let truePrelude = ImmutableArray.CreateBuilder[BoundStatement]()
                EmitAssignmentStatements(local, info, condExpr.WhenTrue, syntax, truePrelude, out _)
                let falsePrelude = ImmutableArray.CreateBuilder[BoundStatement]()
                EmitAssignmentStatements(local, info, condExpr.WhenFalse, syntax, falsePrelude, out _)
                let falseLabel = BoundLabel("<refSkip>__${tempCounter++}")
                let endLabel = BoundLabel("<refSkip>__${tempCounter++}")
                statements.Add(BoundConditionalGotoStatement(nil, falseLabel, cond, jumpIfTrue: false))
                statements.AddRange(truePrelude)
                statements.Add(BoundGotoStatement(nil, endLabel))
                statements.Add(BoundLabelStatement(nil, falseLabel))
                statements.AddRange(falsePrelude)
                statements.Add(BoundLabelStatement(nil, endLabel))
                rebuiltTemplate = nil
                return
            }
            let siteComponents = List[LocalVariableSymbol]()
            let template = HoistAddressTemplate(
                local,
                rhs,
                statements,
                syntax,
                preserveEffects: !crossing.Contains(local),
                stageComponents: true,
                siteComponents
            )
            let slotId = AddConcreteSite(local, info, template, siteComponents)
            if info.TagLocal != nil {
                statements.Add(
                    BoundExpressionStatement(
                        syntax,
                        BoundAssignmentExpression(nil, info.TagLocal, BoundLiteralExpression(nil, slotId))
                    )
                )
            }
            rebuiltTemplate = template
        }

        private func IsSelfVariable(
            expr BoundExpression,
            local LocalVariableSymbol
        ) bool -> RefInitializationHoister.TryGetAliasLocal(expr, out var target) && object.ReferenceEquals(
            target,
            local
        )

        private func TryGetSharedSourceTag(
            info RefLocalInfo,
            expr BoundExpression,
            out tagLocal LocalVariableSymbol?
        ) bool {
            if sharedSites != nil && RefInitializationHoister.TryGetAliasLocal(expr, out var other) &&
                !object.ReferenceEquals(other, info.Local) && refLocals.TryGetValue(other!!, out var otherInfo) &&
                otherInfo.TagLocal != nil {
                tagLocal = otherInfo.TagLocal
                return true
            }
            tagLocal = nil
            return false
        }

        private func IsSelfOrSharedRef(
            info RefLocalInfo,
            local LocalVariableSymbol,
            expr BoundExpression
        ) bool -> IsSelfVariable(expr, local) ||
            TryGetSharedSourceTag(info, expr, out _)

        private func IsNonCompletingExpression(expr BoundExpression) bool {
            if expr.Type == TypeSymbol.Never || expr is BoundThrowExpression {
                return true
            }
            if expr is BoundBlockExpression block {
                return IsNonCompletingExpression(block.Expression)
            }
            if expr is BoundConditionalExpression condExpr {
                return IsNonCompletingExpression(condExpr.WhenTrue) && IsNonCompletingExpression(condExpr.WhenFalse)
            }
            return false
        }

        private func RequiresBranchLowering(info RefLocalInfo, local LocalVariableSymbol, expr BoundExpression) bool {
            let current = RefInitializationHoister.UnwrapManagedAddressOfDeref(expr)
            if IsSelfOrSharedRef(info, local, current) || IsNonCompletingExpression(current) {
                return true
            }
            if current is BoundAssignmentExpression assign &&
                assign.Variable is LocalVariableSymbol target &&
                target.RefKind == RefKind.None &&
                target.Type is ByRefTypeSymbol {
                return true
            }
            if current is BoundBlockExpression block {
                return RequiresBranchLowering(info, local, block.Expression)
            }
            if current is BoundConditionalExpression condExpr {
                return RequiresBranchLowering(info, local, condExpr.WhenTrue) ||
                    RequiresBranchLowering(info, local, condExpr.WhenFalse)
            }
            if current is BoundAddressOfExpression{IsUnmanaged: false, Operand: BoundBlockExpression block} addrBlock {
                return RequiresBranchLowering(info, local, BoundAddressOfExpression(addrBlock.Syntax, block.Expression))
            }
            if current is BoundAddressOfExpression{
                IsUnmanaged: false,
                Operand: BoundConditionalExpression cond
            } addrCond {
                return RequiresBranchLowering(info, local, BoundAddressOfExpression(addrCond.Syntax, cond.WhenTrue)) ||
                    RequiresBranchLowering(info, local, BoundAddressOfExpression(addrCond.Syntax, cond.WhenFalse))
            }
            if current is BoundConditionalAddressExpression condAddr {
                return RequiresBranchLowering(
                    info,
                    local,
                    BoundAddressOfExpression(condAddr.Syntax, condAddr.WhenTrueOperand)
                ) ||
                    RequiresBranchLowering(
                    info,
                    local,
                    BoundAddressOfExpression(condAddr.Syntax, condAddr.WhenFalseOperand)
                )
            }
            return false
        }

        private func EmitNonCompletingExpression(
            expr BoundExpression,
            statements ImmutableArray[BoundStatement].Builder
        ) {
            switch expr {
                case block is BoundBlockExpression {
                    for stmt in block.Statements {
                        let rewritten = RewriteStatement(stmt)
                        if rewritten is BoundBlockStatement nested {
                            statements.AddRange(nested.Statements)
                        } else {
                            statements.Add(rewritten)
                        }
                    }
                    let last = if block.Statements.Length > 0 {
                        block.Statements[block.Statements.Length - 1]
                    } else {
                        default(BoundStatement?)
                    }
                    let endsWithExit = last is BoundReturnStatement or
                        BoundThrowStatement or
                        BoundGotoStatement or
                        BoundRethrowStatement
                    if !(
                        endsWithExit &&
                            block.Expression is BoundThrowExpression{Expression: BoundLiteralExpression{Value: nil}}
                    ) {
                        EmitNonCompletingExpression(block.Expression, statements)
                    }
                }
                case condExpr is BoundConditionalExpression {
                    let cond = RewriteExpression(condExpr.Condition)
                    let falseLabel = BoundLabel("<refSkip>__${tempCounter++}")
                    let endLabel = BoundLabel("<refSkip>__${tempCounter++}")
                    statements.Add(BoundConditionalGotoStatement(nil, falseLabel, cond, jumpIfTrue: false))
                    EmitNonCompletingExpression(condExpr.WhenTrue, statements)
                    statements.Add(BoundGotoStatement(nil, endLabel))
                    statements.Add(BoundLabelStatement(nil, falseLabel))
                    EmitNonCompletingExpression(condExpr.WhenFalse, statements)
                    statements.Add(BoundLabelStatement(nil, endLabel))
                }
                default {
                    statements.Add(BoundExpressionStatement(nil, RewriteExpression(expr)))
                }
            }
        }

        private func HoistAddressTemplate(
            targetLocal LocalVariableSymbol,
            expression BoundExpression,
            prelude ImmutableArray[BoundStatement].Builder,
            syntax SyntaxNode?,
            preserveEffects bool,
            stageComponents bool,
            siteComponents List[LocalVariableSymbol]? = nil
        ) BoundExpression {
            switch expression {
                case block is BoundBlockExpression {
                    for stmt in block.Statements {
                        let rewritten = RewriteStatement(stmt)
                        if rewritten is BoundBlockStatement nested {
                            prelude.AddRange(nested.Statements)
                        } else {
                            prelude.Add(rewritten)
                        }
                    }
                    return HoistAddressTemplate(
                        targetLocal,
                        block.Expression,
                        prelude,
                        syntax,
                        preserveEffects,
                        stageComponents,
                        siteComponents
                    )
                }
                case addressOf is BoundAddressOfExpression {
                    let previousStaged = this.stagedTemps
                    let captured = List[LocalVariableSymbol]()
                    this.stagedTemps = captured
                    var template BoundExpression
                    try {
                        template = HoistOperand(addressOf.Operand, prelude, captureComponents: true)
                    } finally {
                        this.stagedTemps = previousStaged
                    }
                    let rebuiltAddress = addressOf.Update(template)
                    let shouldProbe = (
                        preserveEffects && !OverloadResolver.CanDeferAddressEvaluation(rebuiltAddress)
                    ) ||
                        ShouldProbeTemplate(template)
                    if shouldProbe {
                        prelude.Add(BoundExpressionStatement(syntax, rebuiltAddress))
                    }
                    if stageComponents && shouldProbe && captured.Count > 0 {
                        return CommitStagedTemps(captured, rebuiltAddress, prelude, syntax, siteComponents)
                    }
                    if previousStaged != nil {
                        previousStaged.AddRange(captured)
                    }
                    siteComponents?.AddRange(captured)
                    return rebuiltAddress
                }
                case condAddr is BoundConditionalAddressExpression {
                    let previousStaged = this.stagedTemps
                    let captured = List[LocalVariableSymbol]()
                    this.stagedTemps = captured
                    var hoisted BoundDereferenceExpression
                    try {
                        let wrapped = BoundDereferenceExpression(condAddr.Syntax, condAddr)
                        hoisted = cast[BoundDereferenceExpression](
                            HoistOperand(wrapped, prelude, captureComponents: true)
                        )
                    } finally {
                        this.stagedTemps = previousStaged
                    }
                    let rebuilt = cast[BoundConditionalAddressExpression](hoisted.Operand)
                    prelude.Add(BoundExpressionStatement(syntax, rebuilt))
                    if stageComponents && captured.Count > 0 {
                        return CommitStagedTemps(captured, rebuilt, prelude, syntax, siteComponents)
                    }
                    if previousStaged != nil {
                        previousStaged.AddRange(captured)
                    }
                    siteComponents?.AddRange(captured)
                    return rebuilt
                }
                case condExpr is BoundConditionalExpression {
                    let previousStaged = this.stagedTemps
                    let captured = if stageComponents {
                        List[LocalVariableSymbol]()
                    } else {
                        previousStaged
                    }
                    this.stagedTemps = captured
                    var condition BoundExpression
                    var whenTrue BoundExpression
                    var whenFalse BoundExpression
                    let truePrelude = ImmutableArray.CreateBuilder[BoundStatement]()
                    let falsePrelude = ImmutableArray.CreateBuilder[BoundStatement]()
                    try {
                        condition = HoistIfNeeded(condExpr.Condition, prelude, forceCapture: true)
                        whenTrue = HoistAddressTemplate(
                            targetLocal,
                            condExpr.WhenTrue,
                            truePrelude,
                            syntax,
                            preserveEffects,
                            stageComponents: false
                        )
                        whenFalse = HoistAddressTemplate(
                            targetLocal,
                            condExpr.WhenFalse,
                            falsePrelude,
                            syntax,
                            preserveEffects,
                            stageComponents: false
                        )
                    } finally {
                        this.stagedTemps = previousStaged
                    }
                    if truePrelude.Count != 0 {
                        let skip = BoundLabel("<refSkip>__${tempCounter++}")
                        prelude.Add(BoundConditionalGotoStatement(nil, skip, condition, jumpIfTrue: false))
                        prelude.AddRange(truePrelude)
                        prelude.Add(BoundLabelStatement(nil, skip))
                    }
                    if falsePrelude.Count != 0 {
                        let skip = BoundLabel("<refSkip>__${tempCounter++}")
                        prelude.Add(BoundConditionalGotoStatement(nil, skip, condition, jumpIfTrue: true))
                        prelude.AddRange(falsePrelude)
                        prelude.Add(BoundLabelStatement(nil, skip))
                    }
                    let pointeeType = (cast[ByRefTypeSymbol](targetLocal.Type)).PointeeType
                    let rebuilt = BoundConditionalAddressExpression(
                        condExpr.Syntax,
                        condition,
                        ToOperand(whenTrue),
                        ToOperand(whenFalse),
                        pointeeType
                    )
                    if stageComponents && captured != nil && captured.Count > 0 {
                        return CommitStagedTemps(captured, rebuilt, prelude, syntax, siteComponents)
                    }
                    if stageComponents && captured != nil {
                        siteComponents?.AddRange(captured)
                    }
                    return rebuilt
                }
                case varExpr is BoundVariableExpression when varExpr.Variable is LocalVariableSymbol srcLocal &&
                    srcLocal.Type is ByRefTypeSymbol &&
                    !refLocals.ContainsKey(srcLocal) {
                    let isReassigned = assignmentCounts.TryGetValue(srcLocal, out var assignCount) && assignCount > 0
                    if !isReassigned {
                        return BoundAddressOfExpression(
                            varExpr.Syntax,
                            BoundDereferenceExpression(varExpr.Syntax, varExpr)
                        )
                    }
                    let previousStaged = this.stagedTemps
                    let captured = if stageComponents {
                        List[LocalVariableSymbol]()
                    } else {
                        previousStaged
                    }
                    this.stagedTemps = captured
                    var capturedPointer BoundExpression
                    try {
                        capturedPointer = HoistIfNeeded(varExpr, prelude, forceCapture: true)
                    } finally {
                        this.stagedTemps = previousStaged
                    }
                    let rebuilt = BoundAddressOfExpression(
                        varExpr.Syntax,
                        BoundDereferenceExpression(varExpr.Syntax, capturedPointer)
                    )
                    if stageComponents && captured != nil && captured.Count > 0 {
                        return CommitStagedTemps(captured, rebuilt, prelude, syntax, siteComponents)
                    }
                    if stageComponents && captured != nil {
                        siteComponents?.AddRange(captured)
                    }
                    return rebuilt
                }
                case _ is BoundDefaultExpression {
                    return BoundDefaultExpression(nil, targetLocal.Type)
                }
                default {
                    throw System.InvalidOperationException(
                        "Cannot reconstruct async ref local '${targetLocal.Name}' from expression kind '${expression.Kind}'."
                    )
                }
            }
        }

        private func CommitStagedTemps(
            captured List[LocalVariableSymbol]?,
            rebuilt BoundExpression,
            prelude ImmutableArray[BoundStatement].Builder,
            syntax SyntaxNode?,
            siteComponents List[LocalVariableSymbol]? = nil
        ) BoundExpression {
            if captured == nil || captured.Count == 0 {
                return rebuilt
            }
            let substitutions = Dictionary[VariableSymbol, LocalVariableSymbol]()
            for staged in captured {
                let active = LocalVariableSymbol("<refActive>__${tempCounter++}", isReadOnly: false, staged.Type)
                activeDeclarations.Add(BoundVariableDeclaration(nil, active, BoundDefaultExpression(nil, staged.Type)))
                prelude.Add(
                    BoundExpressionStatement(
                        syntax,
                        BoundAssignmentExpression(nil, active, BoundVariableExpression(nil, staged))
                    )
                )
                substitutions[staged] = active
                siteComponents?.Add(active)
            }
            return VariableSubstituter(substitutions).Rewrite(rebuilt)
        }

        private func ToOperand(template BoundExpression) BoundExpression -> RefLocalInfo.ToAddressOperand(template)

        private func ShouldProbeTemplate(
            template BoundExpression
        ) bool -> template is BoundTupleElementAccessExpression or
            BoundIndexExpression or
            BoundFieldAccessExpression and
            {Receiver: not nil} or
            BoundClrPropertyAccessExpression{Member: FieldInfo, Receiver: not nil} or
            BoundDereferenceExpression{Operand: BoundConditionalAddressExpression} or
            BoundDereferenceExpression{Operand: BoundClrIndexExpression}

        /// Reconstructs [`operand`](paramref) as a side-effect-free
        /// template, emitting hoisting declarations into
        /// [`prelude`](paramref) for any non-trivial sub-expression.
        private func HoistOperand(
            operand BoundExpression,
            prelude ImmutableArray[BoundStatement].Builder,
            captureComponents bool = false
        ) BoundExpression {
            if RefCapabilities.IsRefReturningAccess(operand) && !SideEffectSpiller.IsNativeSliceElementOperand(
                operand
            ) {
                throw System.InvalidOperationException(
                    "Opaque ref-returning storage must be rejected before async address reconstruction."
                )
            }
            switch operand {
                case block is BoundBlockExpression {
                    for statement in block.Statements {
                        prelude.Add(RewriteStatement(statement))
                    }
                    return HoistOperand(block.Expression, prelude, captureComponents)
                }
                case conditional is BoundConditionalExpression {
                    return HoistOperand(
                        BoundDereferenceExpression(
                            conditional.Syntax,
                            BoundConditionalAddressExpression(
                                conditional.Syntax,
                                conditional.Condition,
                                conditional.WhenTrue,
                                conditional.WhenFalse,
                                conditional.Type
                            )
                        ),
                        prelude,
                        captureComponents
                    )
                }
                case BoundDereferenceExpression{Operand: BoundAddressOfExpression address} {
                    return HoistOperand(address.Operand, prelude, captureComponents: true)
                }
                case BoundDereferenceExpression{
                    Operand: BoundVariableExpression{Variable: LocalVariableSymbol aliased}
                } when refLocals.TryGetValue(aliased, out var aliasedInfo) &&
                    aliasedInfo.IsSingleAddressInit &&
                    aliasedInfo.Templates.Count == 1 {
                    return HoistOperand(
                        (cast[BoundAddressOfExpression](aliasedInfo.Templates[0])).Operand,
                        prelude,
                        captureComponents: true
                    )
                }
                case BoundDereferenceExpression{Operand: BoundBlockExpression block} dereference {
                    for statement in block.Statements {
                        prelude.Add(RewriteStatement(statement))
                    }
                    return HoistOperand(
                        BoundDereferenceExpression(dereference.Syntax, block.Expression),
                        prelude,
                        captureComponents: true
                    )
                }
                case BoundDereferenceExpression{Operand: BoundConditionalExpression conditional} dereference {
                    return HoistOperand(
                        BoundDereferenceExpression(
                            dereference.Syntax,
                            BoundConditionalAddressExpression(
                                conditional.Syntax,
                                conditional.Condition,
                                BoundDereferenceExpression(conditional.WhenTrue.Syntax, conditional.WhenTrue),
                                BoundDereferenceExpression(conditional.WhenFalse.Syntax, conditional.WhenFalse),
                                dereference.Type
                            )
                        ),
                        prelude,
                        captureComponents: true
                    )
                }
                case dereference is BoundDereferenceExpression when SideEffectSpiller.IsNativeSliceElementOperand(
                    dereference.Operand
                ) {
                    return BoundDereferenceExpression(
                        dereference.Syntax,
                        HoistOperand(dereference.Operand, prelude, captureComponents: true)
                    )
                }
                case tuple is BoundTupleElementAccessExpression {
                    // Later arguments can replace an owner or index before address reconstruction.
                    return BoundTupleElementAccessExpression(
                        tuple.Syntax,
                        HoistOperand(tuple.Receiver, prelude, captureComponents: true),
                        tuple.TupleType,
                        tuple.Index
                    )
                }
                case idx is BoundIndexExpression {
                    {
                        let target = HoistIfNeeded(idx.Target, prelude, captureComponents)
                        let indices = idx
                            .Indices
                            .Select((index BoundExpression) -> HoistIfNeeded(index, prelude, captureComponents))
                            .ToImmutableArray()
                        return BoundIndexExpression(idx.Syntax, target, indices, idx.Type)
                    }
                }
                case field is BoundFieldAccessExpression {
                    {
                        let fieldReceiver = field.Receiver
                        if fieldReceiver == nil {
                            // A static or interface static-field read (ADR-0089 /
                            // #1030) has no receiver expression to hoist, and
                            // rebuilding it through the receiver constructor would
                            // drop InterfaceType -- the #3333 failure shape. The
                            // base BoundTreeRewriter bails the same way.
                            return field
                        }
                        let receiver = if Binder.IsReferenceTypeForConstraint(fieldReceiver.Type) ||
                            !IsReconstructableStorage(fieldReceiver) {
                            HoistIfNeeded(fieldReceiver, prelude, captureComponents)
                        } else {
                            HoistOperand(fieldReceiver, prelude, captureComponents)
                        }
                        return BoundFieldAccessExpression(
                            field.Syntax,
                            receiver,
                            BoundNodeForm.DeclaringType(field),
                            field.Field,
                            field.SubstitutedType,
                            field.NarrowedType
                        )
                    }
                }
                case clrIdx is BoundClrIndexExpression {
                    {
                        var snapshotAfterArgs = false
                        let receiverLocation = if SideEffectSpiller.IsInPlaceStorageWriteReceiver(clrIdx.Target) {
                            snapshotAfterArgs = true
                            let captured = HoistOperand(clrIdx.Target, prelude, captureComponents: true)
                            if (
                                captured is BoundTupleElementAccessExpression or
                                    BoundIndexExpression or
                                    BoundFieldAccessExpression and
                                    {Receiver: not nil} or
                                    BoundClrPropertyAccessExpression{Member: FieldInfo, Receiver: not nil} or
                                    BoundDereferenceExpression{Operand: BoundConditionalAddressExpression} or
                                    BoundDereferenceExpression{Operand: BoundClrIndexExpression}
                            ) {
                                prelude.Add(
                                    BoundExpressionStatement(
                                        clrIdx.Syntax,
                                        BoundAddressOfExpression(clrIdx.Syntax, captured)
                                    )
                                )
                            }
                            captured
                        } else {
                            HoistIfNeeded(clrIdx.Target, prelude, captureComponents)
                        }
                        let args = ImmutableArray.CreateBuilder[BoundExpression](clrIdx.Arguments.Length)
                        for arg in clrIdx.Arguments {
                            args.Add(HoistIfNeeded(arg, prelude, captureComponents))
                        }
                        let target = if snapshotAfterArgs {
                            HoistIfNeeded(
                                receiverLocation,
                                prelude,
                                forceCapture: captureComponents &&
                                    receiverLocation is not BoundVariableExpression{
                                    Variable: LocalVariableSymbol{IsReadOnly: true, RefKind: RefKind.None}
                                }
                            )
                        } else {
                            receiverLocation
                        }
                        return BoundClrIndexExpression(
                            clrIdx.Syntax,
                            target,
                            clrIdx.Indexer,
                            args.MoveToImmutable(),
                            clrIdx.Type,
                            clrIdx.ConstrainedReceiverTypeParameter,
                            clrIdx.ConstrainedInterfaceType
                        )
                    }
                }
                case clrProp is BoundClrPropertyAccessExpression when clrProp.Receiver != nil {
                    {
                        let owner = clrProp.Receiver!!
                        let receiver = if clrProp.Member is FieldInfo && !Binder.IsReferenceTypeForConstraint(
                            owner.Type
                        ) &&
                            IsReconstructableStorage(owner) {
                            HoistOperand(owner, prelude, captureComponents)
                        } else {
                            HoistIfNeeded(owner, prelude, captureComponents)
                        }
                        return clrProp.WithReceiver(receiver)
                    }
                }
                case BoundDereferenceExpression{Operand: BoundConditionalAddressExpression address} dereference {
                    let condition = HoistIfNeeded(address.Condition, prelude, forceCapture: true)
                    let truePrelude = ImmutableArray.CreateBuilder[BoundStatement]()
                    let whenTrue = HoistOperand(address.WhenTrueOperand, truePrelude, captureComponents: true)
                    let falsePrelude = ImmutableArray.CreateBuilder[BoundStatement]()
                    let whenFalse = HoistOperand(address.WhenFalseOperand, falsePrelude, captureComponents: true)
                    if truePrelude.Count != 0 {
                        let skip = BoundLabel("<refSkip>__${tempCounter++}")
                        prelude.Add(BoundConditionalGotoStatement(nil, skip, condition, jumpIfTrue: false))
                        prelude.AddRange(truePrelude)
                        prelude.Add(BoundLabelStatement(nil, skip))
                    }
                    if falsePrelude.Count != 0 {
                        let skip = BoundLabel("<refSkip>__${tempCounter++}")
                        prelude.Add(BoundConditionalGotoStatement(nil, skip, condition, jumpIfTrue: true))
                        prelude.AddRange(falsePrelude)
                        prelude.Add(BoundLabelStatement(nil, skip))
                    }
                    return BoundDereferenceExpression(
                        dereference.Syntax,
                        BoundConditionalAddressExpression(
                            address.Syntax,
                            condition,
                            whenTrue,
                            whenFalse,
                            address.PointeeType
                        )
                    )
                }
                case dereference is BoundDereferenceExpression {
                    let forceCapturePointer = dereference.Operand is BoundVariableExpression{
                        Variable: LocalVariableSymbol ptrLocal
                    } &&
                        ptrLocal.Type is ByRefTypeSymbol &&
                        !refLocals.ContainsKey(ptrLocal) && assignmentCounts.TryGetValue(
                        ptrLocal,
                        out var assignCount
                    ) &&
                        assignCount > 0
                    return BoundDereferenceExpression(
                        dereference.Syntax,
                        HoistIfNeeded(dereference.Operand, prelude, forceCapture: forceCapturePointer)
                    )
                }
                default {
                    if operand.Type is ByRefTypeSymbol && operand is not BoundVariableExpression {
                        throw System.InvalidOperationException(
                            "Opaque ref-returning storage must be rejected before async address reconstruction."
                        )
                    }
                    // Other operands are repeatable leaves or already spilled storage.
                    return operand
                }
            }
        }

        /// Returns [`expression`](paramref) unchanged when it is trivially
        /// repeatable; otherwise emits a fresh local declaration into
        /// [`prelude`](paramref) and returns a read of that local.
        private func HoistIfNeeded(
            expression BoundExpression,
            prelude ImmutableArray[BoundStatement].Builder,
            forceCapture bool = false
        ) BoundExpression {
            if !forceCapture && RefInitializationHoister.IsTriviallyRepeatable(expression) {
                return expression
            }
            let rewritten = RewriteExpression(expression)
            if rewritten.Type == TypeSymbol.Never {
                prelude.Add(BoundExpressionStatement(nil, rewritten))
                return BoundThrowExpression(nil, BoundLiteralExpression(nil, value: nil))
            }
            let temp = LocalVariableSymbol("<refTmp>__${tempCounter++}", isReadOnly: false, rewritten.Type)
            if let staged = this.stagedTemps {
                staged.Add(temp)
                activeDeclarations.Add(BoundVariableDeclaration(nil, temp, BoundDefaultExpression(nil, rewritten.Type)))
                prelude.Add(BoundExpressionStatement(nil, BoundAssignmentExpression(nil, temp, rewritten)))
            } else {
                prelude.Add(BoundVariableDeclaration(nil, temp, rewritten))
            }
            return BoundVariableExpression(nil, temp)
        }

        shared {
            internal func IsReconstructableStorage(expression BoundExpression) bool {
                return switch expression {
                    case block is BoundBlockExpression: IsReconstructableStorage(block.Expression)
                    case conditional is BoundConditionalExpression: IsReconstructableStorage(conditional.WhenTrue) &&
                        IsReconstructableStorage(conditional.WhenFalse)
                    case tuple is BoundTupleElementAccessExpression: IsReconstructableStorage(tuple.Receiver)
                    case addr is BoundAddressOfExpression: IsReconstructableStorage(addr.Operand)
                    case BoundClrPropertyAccessExpression{Member: FieldInfo, Receiver: nil}: true
                    case BoundClrPropertyAccessExpression{
                        Member: FieldInfo,
                        Receiver: {} receiver
                    }: Binder.IsReferenceTypeForConstraint(receiver.Type) || IsReconstructableStorage(receiver)
                    case _ is BoundVariableExpression: true
                    case _ is BoundDereferenceExpression: true
                    case _ is BoundIndexExpression: true
                    case boundFieldAccessExpression is BoundFieldAccessExpression when boundFieldAccessExpression.Receiver == nil: true
                    case BoundFieldAccessExpression{Receiver: {} receiver}: Binder.IsReferenceTypeForConstraint(
                        receiver.Type
                    ) ||
                        IsReconstructableStorage(receiver)
                    default: false
                }
            }
        }
    }

    private class CopyRewriter : BoundTreeRewriter {
        private let refLocals Dictionary[LocalVariableSymbol, RefLocalInfo]
        private let deferredCopies HashSet[BoundAssignmentExpression]

        init(
            refLocals Dictionary[LocalVariableSymbol, RefLocalInfo],
            deferredCopies HashSet[BoundAssignmentExpression]
        ) {
            this.refLocals = refLocals
            this.deferredCopies = deferredCopies
        }

        protected override func RewriteBlockExpression(node BoundBlockExpression) BoundExpression {
            var statementBuilder ImmutableArray[BoundStatement].Builder? = nil
            for var i = 0; i < node.Statements.Length; i++ {
                let oldStatement = node.Statements[i]
                let newStatement = RewriteStatement(oldStatement)
                if newStatement != oldStatement && statementBuilder == nil {
                    statementBuilder = ImmutableArray.CreateBuilder[BoundStatement](node.Statements.Length)
                    for var j = 0; j < i; j++ {
                        statementBuilder.Add(node.Statements[j])
                    }
                }
                if statementBuilder != nil {
                    if newStatement is BoundBlockStatement block {
                        statementBuilder.AddRange(block.Statements)
                    } else {
                        statementBuilder.Add(newStatement)
                    }
                }
            }
            let expression = RewriteExpression(node.Expression)
            if statementBuilder == nil && expression == node.Expression {
                return node
            }
            return BoundBlockExpression(node.Syntax, statementBuilder?.ToImmutable() ?? node.Statements, expression)
        }

        protected override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
            if node.Variable is LocalVariableSymbol destLocal && refLocals.TryGetValue(destLocal, out var destInfo) &&
                node.Initializer != nil &&
                RefInitializationHoister.TryGetAliasLocal(node.Initializer, out var srcLocal) && refLocals.TryGetValue(
                srcLocal!!,
                out var srcInfo
            ) {
                return CopyVariableDeclaration(destInfo, srcInfo, node.Syntax)
            }
            return base.RewriteVariableDeclaration(node)
        }

        private func CopyVariableDeclaration(
            destInfo RefLocalInfo,
            srcInfo RefLocalInfo,
            syntax SyntaxNode?
        ) BoundStatement {
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            statements.Add(
                BoundVariableDeclaration(nil, destInfo.TagLocal!!, BoundVariableExpression(syntax, srcInfo.TagLocal!!))
            )
            AppendComponentCopies(destInfo, srcInfo, syntax, statements)
            return BoundBlockStatement(nil, statements.ToImmutable())
        }

        protected override func RewriteExpressionStatement(node BoundExpressionStatement) BoundStatement {
            if node.Expression is BoundAssignmentExpression assign &&
                assign.Variable is LocalVariableSymbol destLocal &&
                (destLocal.RefKind == RefKind.None || deferredCopies.Contains(assign)) &&
                refLocals.TryGetValue(destLocal, out var destInfo) && RefInitializationHoister.TryGetAliasLocal(
                assign.Expression,
                out var srcLocal
            ) &&
                refLocals.TryGetValue(srcLocal!!, out var srcInfo) {
                let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                EmitTagAndComponentCopies(destInfo, srcInfo, node.Syntax, statements)
                return if statements.Count == 1 {
                    statements[0]
                } else {
                    cast[BoundStatement](BoundBlockStatement(nil, statements.ToImmutable()))
                }
            }
            return base.RewriteExpressionStatement(node)
        }

        protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
            if node.Variable is LocalVariableSymbol destLocal &&
                (destLocal.RefKind == RefKind.None || deferredCopies.Contains(node)) &&
                refLocals.TryGetValue(destLocal, out var destInfo) && RefInitializationHoister.TryGetAliasLocal(
                node.Expression,
                out var srcLocal
            ) &&
                refLocals.TryGetValue(srcLocal!!, out var srcInfo) {
                let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                EmitTagAndComponentCopies(destInfo, srcInfo, node.Syntax, statements)
                return BoundBlockExpression(
                    node.Syntax,
                    statements.ToImmutable(),
                    BoundVariableExpression(node.Syntax, destLocal)
                )
            }
            return base.RewriteAssignmentExpression(node)
        }

        private func EmitTagAndComponentCopies(
            destInfo RefLocalInfo,
            srcInfo RefLocalInfo,
            syntax SyntaxNode?,
            statements ImmutableArray[BoundStatement].Builder
        ) {
            statements.Add(
                BoundExpressionStatement(
                    syntax,
                    BoundAssignmentExpression(
                        nil,
                        destInfo.TagLocal!!,
                        BoundVariableExpression(syntax, srcInfo.TagLocal!!)
                    )
                )
            )
            AppendComponentCopies(destInfo, srcInfo, syntax, statements)
        }

        private func AppendComponentCopies(
            destInfo RefLocalInfo,
            srcInfo RefLocalInfo,
            syntax SyntaxNode?,
            statements ImmutableArray[BoundStatement].Builder
        ) {
            for var slotId = 0; slotId < destInfo.SiteComponents.Count; slotId++ {
                let destComponents = destInfo.SiteComponents[slotId]
                let srcComponents = srcInfo.SiteComponents[slotId]
                for var i = 0; i < destComponents.Count; i++ {
                    statements.Add(
                        BoundExpressionStatement(
                            syntax,
                            BoundAssignmentExpression(
                                nil,
                                destComponents[i],
                                BoundVariableExpression(syntax, srcComponents[i])
                            )
                        )
                    )
                }
            }
        }
    }

    private class UseRewriter : BoundTreeRewriter {
        private let refLocals Dictionary[LocalVariableSymbol, RefLocalInfo]

        init(refLocals Dictionary[LocalVariableSymbol, RefLocalInfo]) {
            this.refLocals = refLocals
        }

        protected override func RewriteAddressOfExpression(node BoundAddressOfExpression) BoundExpression {
            if !node.IsUnmanaged &&
                node.Operand is BoundVariableExpression varExpr &&
                varExpr.Variable is LocalVariableSymbol local &&
                local.RefKind != RefKind.None &&
                refLocals.TryGetValue(local, out var info) {
                return info.BuildAddressExpression(node.Syntax)
            }
            return base.RewriteAddressOfExpression(node)
        }

        protected override func RewriteDereferenceExpression(node BoundDereferenceExpression) BoundExpression {
            // *refLocal → reconstructed lvalue template.
            if node.Operand is BoundVariableExpression varExpr &&
                varExpr.Variable is LocalVariableSymbol local &&
                refLocals.TryGetValue(local, out var info) {
                return info.BuildDereferenceExpression(node.Syntax)
            }
            return base.RewriteDereferenceExpression(node)
        }

        protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
            if node.Variable is LocalVariableSymbol local && local.RefKind != RefKind.None && refLocals.TryGetValue(
                local,
                out var info
            ) {
                return BoundIndirectAssignmentExpression(
                    node.Syntax,
                    info.BuildAddressExpression(node.Syntax),
                    RewriteExpression(node.Expression)
                )
            }
            return base.RewriteAssignmentExpression(node)
        }

        @SuppressDiagnostic("GSA0005")
        protected override func RewriteFieldAssignmentExpression(node BoundFieldAssignmentExpression) BoundExpression {
            if node.Receiver is LocalVariableSymbol local && local.RefKind != RefKind.None && refLocals.TryGetValue(
                local,
                out var info
            ) {
                return BoundFieldAssignmentExpression.WithExpressionReceiver(
                    node.Syntax,
                    info.BuildDereferenceExpression(node.Syntax),
                    BoundNodeForm.DeclaringType(node),
                    node.Field,
                    RewriteExpression(node.Value),
                    node.ResultType
                )
            }
            return base.RewriteFieldAssignmentExpression(node)
        }

        @SuppressDiagnostic("GSA0005")
        protected override func RewriteIndexAssignmentExpression(node BoundIndexAssignmentExpression) BoundExpression {
            if node.Target is LocalVariableSymbol local && local.RefKind != RefKind.None && refLocals.TryGetValue(
                local,
                out var info
            ) {
                var indexBuilder ImmutableArray[BoundExpression].Builder? = nil
                for var i = 0; i < node.Indices.Length; i++ {
                    let oldIdx = node.Indices[i]
                    let newIdx = RewriteExpression(oldIdx)
                    if newIdx != oldIdx && indexBuilder == nil {
                        indexBuilder = ImmutableArray.CreateBuilder[BoundExpression](node.Indices.Length)
                        for var j = 0; j < i; j++ {
                            indexBuilder.Add(node.Indices[j])
                        }
                    }
                    if indexBuilder != nil {
                        indexBuilder.Add(newIdx)
                    }
                }
                return BoundIndexAssignmentExpression.WithExpressionTarget(
                    node.Syntax,
                    info.BuildDereferenceExpression(node.Syntax),
                    indexBuilder?.ToImmutable() ?? node.Indices,
                    RewriteExpression(node.Value),
                    node.Type
                )
            }
            return base.RewriteIndexAssignmentExpression(node)
        }

        @SuppressDiagnostic("GSA0005")
        protected override func RewriteClrIndexAssignmentExpression(
            node BoundClrIndexAssignmentExpression
        ) BoundExpression {
            if node.Target is LocalVariableSymbol local && local.RefKind != RefKind.None && refLocals.TryGetValue(
                local,
                out var info
            ) {
                var argBuilder ImmutableArray[BoundExpression].Builder? = nil
                for var i = 0; i < node.Arguments.Length; i++ {
                    let oldArg = node.Arguments[i]
                    let newArg = RewriteExpression(oldArg)
                    if newArg != oldArg && argBuilder == nil {
                        argBuilder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                        for var j = 0; j < i; j++ {
                            argBuilder.Add(node.Arguments[j])
                        }
                    }
                    if argBuilder != nil {
                        argBuilder.Add(newArg)
                    }
                }
                return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    node.Syntax,
                    info.BuildDereferenceExpression(node.Syntax),
                    node.Indexer,
                    argBuilder?.ToImmutable() ?? node.Arguments,
                    RewriteExpression(node.Value),
                    node.Type,
                    node.ConstrainedReceiverTypeParameter,
                    node.ConstrainedInterfaceType
                )
            }
            return base.RewriteClrIndexAssignmentExpression(node)
        }

        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
            // Bare ref local usage (e.g., passed to a ref parameter) → &lvalue or conditional address;
            // native var/let ref alias usage → dereferenced lvalue.
            if node.Variable is LocalVariableSymbol local && refLocals.TryGetValue(local, out var info) {
                return if local.RefKind != RefKind.None {
                    info.BuildDereferenceExpression(node.Syntax)
                } else {
                    info.BuildAddressExpression(node.Syntax)
                }
            }
            return base.RewriteVariableExpression(node)
        }
    }

    /// Rewrites [`body`](paramref) by reconstructing ref locals where possible.
    /// @param body The spilled async method body.
    /// @returns The rewritten body, preserving opaque ref locals only within a suspension-free lifetime.
    func Rewrite(body BoundBlockStatement) BoundBlockStatement {
        if body == nil {
            return body
        }
        // First pass: collect ref local declarations and re-seat assignments
        // across the full bound tree in deterministic AST order.
        let collector = Collector()
        collector.Visit(body)
        if collector.OrderedLocals.Count == 0 {
            return body
        }
        let crossing = RefStructAsyncLivenessAnalyzer.FindLocalsLiveAcrossSuspension(
            body,
            collector.OrderedLocals.Cast[VariableSymbol]()
        )
        let rewriteLocals = HashSet[LocalVariableSymbol]()
        for local in collector.StatementLocals {
            if !collector.Declarations.TryGetValue(local, out var decl) {
                continue
            }
            collector.AssignmentCounts.TryGetValue(local, out var assignCount)
            let initAddr = decl.Initializer as BoundAddressOfExpression
            if assignCount == 0 && initAddr != nil {
                if crossing.Contains(local) ||
                    (local.Type is ByRefTypeSymbol && !RefCapabilities.IsBorrowedLocation(initAddr.Operand)) {
                    rewriteLocals.Add(local)
                }
            } else if crossing.Contains(local) {
                rewriteLocals.Add(local)
            }
        }
        var dependencyAdded = true
        while dependencyAdded {
            dependencyAdded = false
            for local in collector.OrderedLocals {
                if !rewriteLocals.Contains(local) {
                    continue
                }
                if collector.Dependencies.TryGetValue(local, out var deps) {
                    for dep in deps {
                        if collector.Declarations.ContainsKey(dep) &&
                            !(collector.OpaqueLocals.Contains(dep) && !crossing.Contains(dep)) &&
                            rewriteLocals.Add(dep) {
                            dependencyAdded = true
                        }
                    }
                }
            }
        }
        if rewriteLocals.Count == 0 {
            return body
        }
        let remaining = List[LocalVariableSymbol]()
        let remainingSet = HashSet[LocalVariableSymbol]()
        for local in collector.OrderedLocals {
            if rewriteLocals.Contains(local) {
                remaining.Add(local)
                remainingSet.Add(local)
            }
        }
        var currentBody = body
        var currentDeclarations = collector.Declarations
        var currentAssignmentCounts = collector.AssignmentCounts
        var tempCounter = 0
        while remaining.Count > 0 {
            let batch = Dictionary[LocalVariableSymbol, RefLocalInfo]()
            for local in remaining {
                var blocked = false
                if collector.Dependencies.TryGetValue(local, out var deps) {
                    for dep in deps {
                        if remainingSet.Contains(dep) {
                            blocked = true
                            break
                        }
                    }
                }
                if !blocked {
                    let assignCount = if currentAssignmentCounts.TryGetValue(local, out var c) {
                        c
                    } else {
                        0
                    }
                    currentDeclarations.TryGetValue(local, out var decl)
                    let isSingleAddressInit = assignCount == 0 && decl?.Initializer is BoundAddressOfExpression
                    let tagLocal = if !isSingleAddressInit {
                        LocalVariableSymbol("<refSlot>__${tempCounter++}", isReadOnly: false, TypeSymbol.Int32)
                    } else {
                        default(LocalVariableSymbol?)
                    }
                    batch[local] = RefLocalInfo(local, tagLocal, isSingleAddressInit)
                }
            }
            var sharedSites List[SharedSite]? = nil
            if batch.Count == 0 {
                // Partition cyclic aliases into same-typed sink SCCs so
                // independent pointee types never share a branch-join dispatch
                // table and upstream dependents wait for downstream cycles.
                let componentSet = CollectSameTypeSinkComponent(remaining, remainingSet, collector.Dependencies)
                sharedSites = List[SharedSite]()
                for local in remaining {
                    if componentSet.Contains(local) {
                        let tagLocal = LocalVariableSymbol(
                            "<refSlot>__${tempCounter++}",
                            isReadOnly: false,
                            TypeSymbol.Int32
                        )
                        batch[local] = RefLocalInfo(local, tagLocal, isSingleAddressInit: false)
                    }
                }
            }
            let defRewriter = DefinitionRewriter(batch, crossing, currentAssignmentCounts, tempCounter, sharedSites)
            currentBody = cast[BoundBlockStatement](defRewriter.RewriteStatement(currentBody))
            tempCounter = defRewriter.TempCounter
            let extraDeclarations = List[BoundStatement]()
            extraDeclarations.AddRange(defRewriter.ActiveDeclarations)
            if sharedSites != nil {
                for var slotId = 0; slotId < sharedSites.Count; slotId++ {
                    let site = sharedSites[slotId]
                    for local in remaining {
                        if !batch.TryGetValue(local, out var info) {
                            continue
                        }
                        if object.ReferenceEquals(local, site.Owner) {
                            info.Templates.Add(site.Template)
                            info.SiteComponents.Add(site.Components)
                        } else {
                            let clonedComponents = List[LocalVariableSymbol](site.Components.Count)
                            let cloneMap = Dictionary[VariableSymbol, LocalVariableSymbol]()
                            for comp in site.Components {
                                let clone = LocalVariableSymbol(
                                    "<refActive>__${tempCounter++}",
                                    isReadOnly: false,
                                    comp.Type
                                )
                                extraDeclarations.Add(
                                    BoundVariableDeclaration(nil, clone, BoundDefaultExpression(nil, comp.Type))
                                )
                                clonedComponents.Add(clone)
                                cloneMap[comp] = clone
                            }
                            let clonedTemplate = if cloneMap.Count == 0 {
                                site.Template
                            } else {
                                VariableSubstituter(cloneMap).Rewrite(site.Template)
                            }
                            info.Templates.Add(clonedTemplate)
                            info.SiteComponents.Add(clonedComponents)
                        }
                    }
                }
                let copyRewriter = CopyRewriter(batch, defRewriter.DeferredCopies)
                currentBody = cast[BoundBlockStatement](copyRewriter.RewriteStatement(currentBody))
            }
            if extraDeclarations.Count > 0 {
                let withActive = ImmutableArray.CreateBuilder[BoundStatement](
                    extraDeclarations.Count + currentBody.Statements.Length
                )
                withActive.AddRange(extraDeclarations)
                withActive.AddRange(currentBody.Statements)
                currentBody = BoundBlockStatement(currentBody.Syntax, withActive.ToImmutable())
            }
            let useRewriter = UseRewriter(batch)
            currentBody = cast[BoundBlockStatement](useRewriter.RewriteStatement(currentBody))
            for var i = remaining.Count - 1; i >= 0; i-- {
                let local = remaining[i]
                if batch.ContainsKey(local) {
                    remaining.RemoveAt(i)
                    remainingSet.Remove(local)
                }
            }
            if remaining.Count > 0 {
                let roundCollector = Collector()
                roundCollector.Visit(currentBody)
                currentDeclarations = roundCollector.Declarations
                currentAssignmentCounts = roundCollector.AssignmentCounts
            }
        }
        return currentBody
    }

    private func StrongConnectSinkScc(
        v LocalVariableSymbol,
        remaining List[LocalVariableSymbol],
        remainingSet HashSet[LocalVariableSymbol],
        dependencies Dictionary[LocalVariableSymbol, HashSet[LocalVariableSymbol]],
        indices Dictionary[LocalVariableSymbol, int32],
        lowlink Dictionary[LocalVariableSymbol, int32],
        onStack HashSet[LocalVariableSymbol],
        stack List[LocalVariableSymbol],
        ref nextIndex int32,
        ref sinkScc HashSet[LocalVariableSymbol]?
    ) {
        indices[v] = nextIndex
        lowlink[v] = nextIndex
        nextIndex++
        stack.Add(v)
        onStack.Add(v)
        if dependencies.TryGetValue(v, out var deps) {
            for w in remaining {
                if !remainingSet.Contains(w) || !deps.Contains(w) {
                    continue
                }
                if !indices.TryGetValue(w, out var wIdx) {
                    StrongConnectSinkScc(
                        w,
                        remaining,
                        remainingSet,
                        dependencies,
                        indices,
                        lowlink,
                        onStack,
                        stack,
                        ref nextIndex,
                        ref sinkScc
                    )
                    if sinkScc != nil {
                        return
                    }
                    if lowlink[w] < lowlink[v] {
                        lowlink[v] = lowlink[w]
                    }
                } else if onStack.Contains(w) && wIdx < lowlink[v] {
                    lowlink[v] = wIdx
                }
            }
        }
        if lowlink[v] == indices[v] {
            let scc = HashSet[LocalVariableSymbol]()
            while true {
                let top = stack[stack.Count - 1]
                stack.RemoveAt(stack.Count - 1)
                onStack.Remove(top)
                scc.Add(top)
                if object.ReferenceEquals(top, v) {
                    break
                }
            }
            sinkScc = scc
        }
    }

    private func CollectSameTypeSinkComponent(
        remaining List[LocalVariableSymbol],
        remainingSet HashSet[LocalVariableSymbol],
        dependencies Dictionary[LocalVariableSymbol, HashSet[LocalVariableSymbol]]
    ) HashSet[LocalVariableSymbol] {
        var nextIndex = 0
        let indices = Dictionary[LocalVariableSymbol, int32]()
        let lowlink = Dictionary[LocalVariableSymbol, int32]()
        let onStack = HashSet[LocalVariableSymbol]()
        let stack = List[LocalVariableSymbol]()
        var sinkScc HashSet[LocalVariableSymbol]? = nil
        for node in remaining {
            if !indices.ContainsKey(node) {
                StrongConnectSinkScc(
                    node,
                    remaining,
                    remainingSet,
                    dependencies,
                    indices,
                    lowlink,
                    onStack,
                    stack,
                    ref nextIndex,
                    ref sinkScc
                )
                if sinkScc != nil {
                    break
                }
            }
        }
        let sccSet = sinkScc!!
        var seed = remaining[0]
        for candidate in remaining {
            if sccSet.Contains(candidate) {
                seed = candidate
                break
            }
        }
        let seedPointee = GetPointeeType(seed)
        let component = HashSet[LocalVariableSymbol]()
        for candidate in remaining {
            if sccSet.Contains(candidate) && GetPointeeType(candidate) == seedPointee {
                component.Add(candidate)
            }
        }
        return component
    }

    /// Returns `true` when [`expression`](paramref) can
    /// be re-evaluated arbitrarily many times without observable side effects
    /// and without re-running user code: pure leaves like variable reads,
    /// parameter reads, literals, and the implicit `this`/state-machine
    /// receiver. Anything else (calls, indexers, field/property reads, casts,
    /// arithmetic, etc.) is hoisted into a temporary.
    private func GetPointeeType(local LocalVariableSymbol) TypeSymbol -> if local.Type is ByRefTypeSymbol byRef {
        byRef.PointeeType
    } else {
        local.Type
    }

    private func UnwrapManagedAddressOfDeref(expr BoundExpression) BoundExpression {
        var current = expr
        while true {
            if current is BoundAddressOfExpression{
                IsUnmanaged: false,
                Operand: BoundDereferenceExpression{Operand: {} inner}
            } &&
                inner.Type is ByRefTypeSymbol {
                current = inner
            } else if current is BoundAddressOfExpression{
                IsUnmanaged: false,
                Operand: BoundVariableExpression{Variable: LocalVariableSymbol refAlias}
            } addrOfAlias &&
                refAlias.RefKind != RefKind.None {
                current = addrOfAlias.Operand
            } else {
                break
            }
        }
        return current
    }

    private func TryGetAliasLocal(expr BoundExpression, out local LocalVariableSymbol?) bool {
        let current = UnwrapManagedAddressOfDeref(expr)
        if current is BoundVariableExpression{Variable: LocalVariableSymbol candidate} &&
            (candidate.Type is ByRefTypeSymbol || candidate.RefKind != RefKind.None) {
            local = candidate
            return true
        }
        local = nil
        return false
    }

    internal func ContainsOpaqueStorage(expression BoundExpression) bool {
        return switch expression {
            case block is BoundBlockExpression: ContainsOpaqueStorage(block.Expression)
            case conditional is BoundConditionalExpression: ContainsOpaqueStorage(conditional.WhenTrue) ||
                ContainsOpaqueStorage(conditional.WhenFalse)
            case condAddr is BoundConditionalAddressExpression: ContainsOpaqueStorage(condAddr.WhenTrueOperand) ||
                ContainsOpaqueStorage(condAddr.WhenFalseOperand)
            case assign is BoundAssignmentExpression: ContainsOpaqueStorage(assign.Expression)
            case _ is BoundDefaultExpression: false
            case addr is BoundAddressOfExpression: !addr.IsUnmanaged && ContainsOpaqueStorage(addr.Operand)
            case deref is BoundDereferenceExpression: deref.Operand.Type is ByRefTypeSymbol &&
                ContainsOpaqueStorage(deref.Operand)
            default: !DefinitionRewriter.IsReconstructableStorage(expression)
        }
    }

    private func IsTriviallyRepeatable(expression BoundExpression) bool {
        return expression is BoundLiteralExpression ||
            expression is BoundDefaultExpression ||
            (
            expression is BoundVariableExpression varExpr &&
                !(varExpr.Variable is LocalVariableSymbol l && l.RefKind != RefKind.None) &&
                !(varExpr.Variable is ParameterSymbol p && p.RefKind != RefKind.None)
        )
    }
}
