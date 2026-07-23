// <copyright file="ConstructorBodyEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'internal' members should come before 'private' members (methods keep their original ReflectionMetadataEmitter band order: entry points interleaved with the private helpers they orchestrate)
#pragma warning disable SA1204 // static members should come before non-static (the field-initializer statement builders sit next to the emitters that consume them, preserving band order)
#pragma warning disable SA1515 // single-line comment preceded by blank line (inherited from the ReflectionMetadataEmitter band; bodies are verbatim moves)
#pragma warning disable SA1611 // parameter documentation missing — the API surface is mechanically lifted from ReflectionMetadataEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-15 (#1361): constructor-body-bytes emitter. Owns the band that builds
/// the raw IL bodies for every synthesized or user-authored constructor shape:
/// static constructors (class and interface <c>.cctor</c>s, issue #262 /
/// #1030), the default/primary/base-initializer/explicit-body instance
/// constructors (issues #640/#306), and the class deinitializer (<c>Finalize</c>
/// override, ADR-0068 / issue #698), plus the instance-field-initializer
/// statement builders they all share.
/// </summary>
/// <remarks>
/// <para>
/// Wired with a back-reference to the root emitter (the MethodBodyEmitter /
/// InterfaceImplEmitter idiom) because the bodies construct the still-private
/// <see cref="ReflectionMetadataEmitter"/>.<c>MethodBodyEmitSession</c> scaffold
/// (widened <c>private</c> → <c>internal</c> for this extraction) and resolve
/// field tokens via <see cref="UserTokenResolver.ResolveFieldToken"/>.
/// Direct fields hold the shared <see cref="EmitContext"/> and
/// <see cref="MetadataTokenCache"/>; the interface-<c>.cctor</c> MethodDef's
/// parameter-list anchor comes in through the <c>nextParameterHandle</c>
/// callback (the same <see cref="CustomAttributeEncoder.NextParameterHandle"/>
/// method-group TypeDefEmitter already receives).
/// </para>
/// <para>
/// The mutable <c>currentStaticConstructorOwner</c> flag (Issue #1525: which
/// type's <c>.cctor</c> is being emitted, consulted by
/// <see cref="ReflectionMetadataEmitter.IsStaticFieldAddressLegalHere"/> for
/// the <c>initonly</c>-static-field receiver-spill decision) moved to
/// <see cref="EmitContext.CurrentStaticConstructorOwner"/> so both this emitter
/// (which sets it) and the root predicate (which reads it) share one location.
/// Method bodies are verbatim moves; emitted PEs are byte-identical with the
/// pre-E-15 baseline.
/// </para>
/// </remarks>
internal sealed class ConstructorBodyEmitter
{
    private readonly ReflectionMetadataEmitter outer;
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly Func<ParameterHandle> nextParameterHandle;

    public ConstructorBodyEmitter(ReflectionMetadataEmitter outer, Func<ParameterHandle> nextParameterHandle)
    {
        this.outer = outer ?? throw new ArgumentNullException(nameof(outer));
        this.emitCtx = outer.emitCtx;
        this.cache = outer.cache;
        this.nextParameterHandle = nextParameterHandle ?? throw new ArgumentNullException(nameof(nextParameterHandle));
    }

    /// <summary>
    /// Issue #262: builds the IL body for a static constructor (<c>.cctor</c>)
    /// that runs each <see cref="StructSymbol.StaticFieldInitializers"/> in
    /// declaration order. Returns the resulting body offset.
    /// </summary>
    internal int EmitStaticConstructorBodyBytes(StructSymbol typeSym)
    {
        // Build a synthetic body: for each field with an initializer,
        // emit the expression + stsfld.
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        foreach (var field in typeSym.StaticFields)
        {
            if (typeSym.StaticFieldInitializers.TryGetValue(field, out var initExpr))
            {
                // Synthesize: field = initExpr (as an expression statement).
                var assignment = new BoundFieldAssignmentExpression(null, null, typeSym, field, initExpr);
                statements.Add(new BoundExpressionStatement(null, assignment));
            }
        }

        // ADR-0140 / issue #2131: append the type's `shared { init { … } }`
        // static-initializer statements after the field initializers, in source
        // order, so they run as part of the same `.cctor` (matching a C# static
        // constructor whose body follows the field initializers).
        if (typeSym.HasStaticInitializerBlock)
        {
            statements.AddRange(typeSym.StaticInitializerStatements);
        }

        var body = new BoundBlockStatement(null, statements.ToImmutable());
        var previousOwner = this.emitCtx.CurrentStaticConstructorOwner;
        this.emitCtx.CurrentStaticConstructorOwner = typeSym;
        try
        {
            return this.EmitStaticConstructorBodyFromBlock(body, typeSym.Declaration);
        }
        finally
        {
            this.emitCtx.CurrentStaticConstructorOwner = previousOwner;
        }
    }

    /// <summary>
    /// ADR-0089 / issue #1030: emits the interface <c>.cctor</c> (type
    /// initializer) running the interface's static-field initializers. Mirrors
    /// <c>TypeDefEmitter.EmitStaticConstructor</c> but resolves the body via the
    /// interface-specific body-bytes helper. The MethodDef lands in the row
    /// reserved by PlanInterfaceMethods (last in the interface's method run).
    /// </summary>
    /// <param name="ifaceSym">The interface whose static constructor is emitted.</param>
    internal void EmitInterfaceStaticConstructor(InterfaceSymbol ifaceSym)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            bodyOffset = this.EmitInterfaceStaticConstructorBodyBytes(ifaceSym);
        }

        var cctorSig = new BlobBuilder();
        new BlobEncoder(cctorSig).MethodSignature(isInstanceMethod: false)
            .Parameters(0, r => r.Void(), _ => { });

        this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName | MethodAttributes.Static,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".cctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(cctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// ADR-0089 / issue #1030: builds the IL body for an interface
    /// <c>.cctor</c> running each interface static-field initializer in
    /// declaration order. Interface static fields are plain CLR static fields,
    /// so the synthesized assignment carries a <c>null</c> declaring struct and
    /// the emitter resolves the field handle by symbol identity.
    /// </summary>
    /// <param name="ifaceSym">The interface whose static initializers run.</param>
    /// <returns>The resulting method body offset.</returns>
    private int EmitInterfaceStaticConstructorBodyBytes(InterfaceSymbol ifaceSym)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        foreach (var field in ifaceSym.StaticFields)
        {
            if (ifaceSym.StaticFieldInitializers.TryGetValue(field, out var initExpr))
            {
                var assignment = new BoundFieldAssignmentExpression(null, field, ifaceSym, initExpr);
                statements.Add(new BoundExpressionStatement(null, assignment));
            }
        }

        var body = new BoundBlockStatement(null, statements.ToImmutable());
        var previousOwner = this.emitCtx.CurrentStaticConstructorOwner;
        this.emitCtx.CurrentStaticConstructorOwner = ifaceSym;
        try
        {
            return this.EmitStaticConstructorBodyFromBlock(body, ifaceSym.Declaration);
        }
        finally
        {
            this.emitCtx.CurrentStaticConstructorOwner = previousOwner;
        }
    }

    /// <summary>
    /// Shared IL-emission core for a synthesized <c>.cctor</c> body (Issue #262
    /// / issue #1030). Plans locals/labels, emits the block, appends
    /// <c>ret</c>, and returns the resulting body offset.
    /// </summary>
    /// <param name="body">The synthesized static-constructor block.</param>
    /// <param name="anchor">The declaring-type syntax used as the diagnostic anchor.</param>
    /// <returns>The resulting method body offset.</returns>
    private int EmitStaticConstructorBodyFromBlock(BoundBlockStatement body, SyntaxNode anchor)
    {
        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        var session = new ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il);
        session.Plan(body);

        var localsSignature = session.BuildLocalsSignature();
        var emitter = session.CreateEmitter(new Dictionary<ParameterSymbol, int>());

        try
        {
            emitter.EmitBlock(body);
        }
        catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
        {
            var fallbackAnchor = emitter.CurrentAnchor ?? anchor;
            EmitDiagnosticException.Wrap(fallbackAnchor, ex);
        }

        il.OpCode(ILOpCode.Ret);

        return this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature);
    }

    /// <summary>
    /// Issue #640: builds the IL body for a default parameterless constructor
    /// that calls the base ctor and then evaluates instance field initializers
    /// in declaration order. Returns the resulting body offset.
    /// </summary>
    internal int EmitClassDefaultConstructorBodyBytes(StructSymbol classSym, EntityHandle baseCtorToken)
    {
        // Synthesize a `this` parameter for the field-initializer receiver.
        var thisParam = new ParameterSymbol("this", classSym);

        // Synthesize field-initializer assignment statements.
        var statements = BuildInstanceFieldInitializerStatements(classSym, thisParam);
        var body = new BoundBlockStatement(null, statements);

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        var session = new ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il);
        session.Plan(body);

        var parameters = new Dictionary<ParameterSymbol, int>
        {
            [thisParam] = 0,
        };

        var localsSignature = session.BuildLocalsSignature();
        var emitter = session.CreateEmitter(parameters);

        // base()
        il.LoadArgument(0);
        il.OpCode(ILOpCode.Call);
        il.Token(baseCtorToken);

        // Instance field initializers
        try
        {
            emitter.EmitBlock(body);
        }
        catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
        {
            var anchor = emitter.CurrentAnchor ?? classSym.Declaration;
            EmitDiagnosticException.Wrap(anchor, ex);
        }

        il.OpCode(ILOpCode.Ret);
        return this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature);
    }

    /// <summary>
    /// Issue #640: builds the IL body for a primary constructor that calls
    /// the base ctor, assigns primary-ctor parameters into their same-named
    /// fields, and then evaluates instance field initializers in declaration
    /// order. Returns the resulting body offset.
    /// </summary>
    internal int EmitClassPrimaryConstructorBodyBytes(StructSymbol classSym, EntityHandle baseCtorToken)
    {
        var parameters = classSym.PrimaryConstructorParameters;

        // Synthesize a `this` parameter for the field-initializer receiver.
        var thisParam = new ParameterSymbol("this", classSym);

        // Synthesize field-initializer assignment statements.
        var statements = BuildInstanceFieldInitializerStatements(classSym, thisParam);
        var body = new BoundBlockStatement(null, statements);

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        var session = new ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il);
        session.Plan(body);

        var paramSlots = new Dictionary<ParameterSymbol, int>
        {
            [thisParam] = 0,
        };
        for (var i = 0; i < parameters.Length; i++)
        {
            paramSlots[parameters[i]] = i + 1;
        }

        var localsSignature = session.BuildLocalsSignature();
        var emitter = session.CreateEmitter(paramSlots);

        // base()
        il.LoadArgument(0);
        il.OpCode(ILOpCode.Call);
        il.Token(baseCtorToken);

        // Primary ctor parameter → field assignments. ADR-0087 §3 R3:
        // for a generic class the stfld must reference the field via
        // a MemberRef parented at the self-instantiation TypeSpec so
        // ilverify accepts the receiver type (`Box`1<!0>`).
        for (var i = 0; i < parameters.Length; i++)
        {
            var param = parameters[i];
            if (!ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(classSym, param.Name, out var field))
            {
                throw new InvalidOperationException($"Class '{classSym.Name}' has no field for primary ctor parameter '{param.Name}'.");
            }

            var fieldHandle = this.outer.userTokens.ResolveFieldToken(classSym, field);

            il.LoadArgument(0);
            il.LoadArgument(i + 1);
            il.OpCode(ILOpCode.Stfld);
            il.Token(fieldHandle);
        }

        // Instance field initializers
        try
        {
            emitter.EmitBlock(body);
        }
        catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
        {
            var anchor = emitter.CurrentAnchor ?? classSym.Declaration;
            EmitDiagnosticException.Wrap(anchor, ex);
        }

        il.OpCode(ILOpCode.Ret);
        return this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature);
    }

    internal static bool NeedsInstanceFieldInitializerStatements(StructSymbol classSym)
        => !classSym.InstanceFieldInitializers.IsEmpty;

    /// <summary>
    /// Issue #640: builds the bound assignment statements for all instance
    /// field initializers in declaration order. Used by the default, primary,
    /// forwarding, and explicit constructor body emitters.
    /// </summary>
    private static ImmutableArray<BoundStatement> BuildInstanceFieldInitializerStatements(StructSymbol classSym, ParameterSymbol thisParam = null)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        foreach (var field in classSym.Fields)
        {
            if (classSym.InstanceFieldInitializers.TryGetValue(field, out var initExpr))
            {
                var assignment = new BoundFieldAssignmentExpression(null, thisParam, classSym, field, initExpr);
                statements.Add(new BoundExpressionStatement(null, assignment));
            }
        }

        return statements.ToImmutable();
    }

    /// <summary>
    /// Issue #306: builds the IL body for a forwarding constructor that
    /// runs <c>base(args)</c> before assigning the primary-constructor
    /// parameters into their same-named fields. Returns the resulting
    /// body offset.
    /// </summary>
    internal int EmitClassConstructorWithBaseInitializerBodyBytes(
        StructSymbol classSym,
        ImmutableArray<ParameterSymbol> parameters,
        BaseConstructorInitializer init,
        EntityHandle baseCtorToken)
    {
        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

        // Synthesize a `this` parameter for the field-initializer receiver.
        var thisParam = new ParameterSymbol("this", classSym);

        var session = new ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il);

        // Pre-scan the base arguments so any scratch slots they require are
        // allocated and registered in the locals signature.
        if (!init.Arguments.IsDefaultOrEmpty)
        {
            var synth = ImmutableArray.CreateBuilder<BoundStatement>(init.Arguments.Length);
            foreach (var arg in init.Arguments)
            {
                synth.Add(new BoundExpressionStatement(null, arg));
            }

            session.Plan(new BoundBlockStatement(null, synth.ToImmutable()));
        }

        // Issue #640: pre-scan instance field initializer expressions for locals.
        BoundBlockStatement fieldInitBody = null;
        if (NeedsInstanceFieldInitializerStatements(classSym))
        {
            fieldInitBody = new BoundBlockStatement(null, BuildInstanceFieldInitializerStatements(classSym, thisParam));
            session.Plan(fieldInitBody);
        }

        var paramSlots = new Dictionary<ParameterSymbol, int>
        {
            [thisParam] = 0,
        };
        for (var i = 0; i < parameters.Length; i++)
        {
            paramSlots[parameters[i]] = i + 1;
        }

        var localsSignature = session.BuildLocalsSignature();
        var emitter = session.CreateEmitter(paramSlots);

        // base(args) — `this` followed by the (ref-kind aware) base arguments.
        il.LoadArgument(0);
        if (!init.Arguments.IsDefaultOrEmpty)
        {
            emitter.EmitBaseConstructorArguments(init.Arguments, init.ArgumentRefKinds);
        }

        il.OpCode(ILOpCode.Call);
        il.Token(baseCtorToken);

        // this.<field> = arg; positional 1:1 with same-named fields.
        // Issue #2338 / ADR-0087 §3 R3: for a generic class the stfld must
        // reference the field via a MemberRef parented at the
        // self-instantiation TypeSpec (ResolveFieldToken), not the bare
        // open FieldDef, or ilverify rejects the constructed receiver.
        for (var i = 0; i < parameters.Length; i++)
        {
            var param = parameters[i];
            if (!ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(classSym, param.Name, out var field))
            {
                throw new InvalidOperationException($"Class '{classSym.Name}' has no field for primary ctor parameter '{param.Name}'.");
            }

            var fieldHandle = this.outer.userTokens.ResolveFieldToken(classSym, field);

            il.LoadArgument(0);
            il.LoadArgument(i + 1);
            il.OpCode(ILOpCode.Stfld);
            il.Token(fieldHandle);
        }

        // Issue #640: emit instance field initializer assignments.
        if (fieldInitBody != null)
        {
            try
            {
                emitter.EmitBlock(fieldInitBody);
            }
            catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
            {
                var anchor = emitter.CurrentAnchor ?? classSym.Declaration;
                EmitDiagnosticException.Wrap(anchor, ex);
            }
        }

        il.OpCode(ILOpCode.Ret);
        return this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature);
    }

    /// <summary>
    /// Issue #306 / #2766: builds the IL body for a class or plain-struct constructor materialized
    /// from an explicit <c>init(...)</c> declaration. Chains to the base
    /// (either the explicit <c>: base(args)</c> initializer or the
    /// conventional parameterless chain) and then runs the user-authored
    /// constructor body via <see cref="MethodBodyEmitter.EmitBlock"/>. Returns
    /// the resulting body offset.
    /// </summary>
    internal int EmitClassConstructorWithBodyBodyBytes(
        StructSymbol classSym,
        ConstructorSymbol ctor,
        BaseConstructorInitializer init,
        EntityHandle baseCtorToken)
    {
        var function = ctor.Function;
        var body = this.emitCtx.Program.Functions[function];

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        var session = new ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il);

        // Pre-scan the base arguments so any scratch slots they require are
        // allocated and registered in the locals signature. ADR-0065 §2:
        // convenience inits skip the base-call emission so their `init`
        // syntax-side `: base()` (if present, but rejected at bind time) and
        // the implicit empty-args case are irrelevant here.
        if (!ctor.IsConvenience && init != null && !init.Arguments.IsDefaultOrEmpty)
        {
            var synth = ImmutableArray.CreateBuilder<BoundStatement>(init.Arguments.Length);
            foreach (var arg in init.Arguments)
            {
                synth.Add(new BoundExpressionStatement(null, arg));
            }

            session.Plan(new BoundBlockStatement(null, synth.ToImmutable()));
        }

        // Issue #640: pre-scan instance field initializer expressions for locals.
        // ADR-0065 §2: convenience inits skip field-init emission (the
        // chained-to designated init handles them), so don't reserve scratch
        // slots for those expressions either.
        BoundBlockStatement fieldInitBody = null;
        if (!ctor.IsConvenience && NeedsInstanceFieldInitializerStatements(classSym))
        {
            fieldInitBody = new BoundBlockStatement(null, BuildInstanceFieldInitializerStatements(classSym, function.ThisParameter));
            session.Plan(fieldInitBody);
        }

        session.CollectConstValues(body);
        session.Plan(body, function);

        // Slot 0 is the implicit `this`; user parameters shift up by one.
        var paramSlots = new Dictionary<ParameterSymbol, int>
        {
            [function.ThisParameter] = 0,
        };
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            paramSlots[function.Parameters[i]] = i + 1;
        }

        var localsSignature = session.BuildLocalsSignature();
        var emitter = session.CreateEmitter(
            paramSlots,
            structThisParameter: classSym.IsClass ? null : function.ThisParameter);

        // ADR-0065 §2: a `convenience init(...)` does NOT chain to the base
        // constructor itself — the user-authored body begins with an
        // `init(args)` self-delegation (BoundConstructorChainingExpression)
        // that calls a sibling constructor on the same aggregate. That sibling
        // is responsible for the base chain. We also skip the instance
        // field-initializer emit step here: the chained-to designated
        // initializer will run those initializers exactly once.
        if (!ctor.IsConvenience)
        {
            if (classSym.IsClass)
            {
                // base(args) — `this` followed by the (ref-kind aware) base arguments.
                il.LoadArgument(0);
                if (init != null && !init.Arguments.IsDefaultOrEmpty)
                {
                    emitter.EmitBaseConstructorArguments(init.Arguments, init.ArgumentRefKinds);
                }

                il.OpCode(ILOpCode.Call);
                il.Token(baseCtorToken);
            }
            else
            {
                // CLR value-type constructors do not call System.ValueType::.ctor.
                // Zero the receiver first, matching C#'s definite-assignment/default
                // initialization semantics for fields the source body does not write.
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Initobj);
                il.Token(this.outer.userTokens.ResolveUserTypeToken(classSym));
            }

            // Issue #640: emit instance field initializer assignments before
            // the user-authored constructor body (matching C# semantics).
            if (fieldInitBody != null)
            {
                try
                {
                    emitter.EmitBlock(fieldInitBody);
                }
                catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
                {
                    var anchor = emitter.CurrentAnchor ?? classSym.Declaration;
                    EmitDiagnosticException.Wrap(anchor, ex);
                }
            }
        }

        // Run the user-authored constructor body.
        try
        {
            emitter.EmitBlock(body);
        }
        catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
        {
            var anchor = emitter.CurrentAnchor ?? classSym.Declaration ?? body.Syntax;
            EmitDiagnosticException.Wrap(anchor, ex);
        }

        il.OpCode(ILOpCode.Ret);
        return this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature);
    }

    // ADR-0068 / issue #698: emits the body of the synthesized `Finalize`
    // override produced by a class `deinit { … }`. The body wraps the
    // lowered user body in `try { … } finally { base.Finalize(); }` exactly
    // as the C# compiler emits for `~Type()`. Mirrors the locals/labels
    // pre-scan scaffolding from `EmitClassConstructorWithBodyBodyBytes`.
    internal int EmitClassDeinitializerBodyBytes(
        StructSymbol classSym,
        DeinitSymbol deinit,
        BoundBlockStatement body,
        EntityHandle baseFinalizeRef)
    {
        _ = classSym;
        var function = deinit.Function;

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        var session = new ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il);

        session.CollectConstValues(body);
        session.Plan(body, function);

        // Slot 0 is the implicit `this`; deinit has no user parameters.
        var paramSlots = new Dictionary<ParameterSymbol, int>
        {
            [function.ThisParameter] = 0,
        };

        var localsSignature = session.BuildLocalsSignature();
        var emitter = session.CreateEmitter(paramSlots);

        // Wrap the user body in try { … } finally { base.Finalize(); }.
        // Matches the IL shape Roslyn emits for `~Type()`. The base
        // Finalize target is the closest user-declared base `deinit` (if
        // any) — emit a non-virtual `call` to its MethodDef — otherwise
        // chain straight to System.Object::Finalize().
        var tryStart = il.DefineLabel();
        var finallyStart = il.DefineLabel();
        var finallyEnd = il.DefineLabel();

        il.MarkLabel(tryStart);
        try
        {
            emitter.EmitBlock(body);
        }
        catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
        {
            var anchor = emitter.CurrentAnchor ?? classSym.Declaration ?? body.Syntax;
            EmitDiagnosticException.Wrap(anchor, ex);
        }

        il.Branch(ILOpCode.Leave, finallyEnd);

        il.MarkLabel(finallyStart);
        il.LoadArgument(0);
        il.OpCode(ILOpCode.Call);

        EntityHandle baseFinalizeToken = baseFinalizeRef;
        for (var ancestor = classSym.BaseClass; ancestor != null; ancestor = ancestor.BaseClass)
        {
            if (ancestor.Deinitializer != null
                && this.cache.MethodHandles.TryGetValue(ancestor.Deinitializer.Function, out var ancestorHandle))
            {
                baseFinalizeToken = ancestorHandle;
                break;
            }
        }

        il.Token(baseFinalizeToken);
        il.OpCode(ILOpCode.Endfinally);
        il.MarkLabel(finallyEnd);

        il.ControlFlowBuilder.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd);

        il.OpCode(ILOpCode.Ret);
        return this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature);
    }
}
