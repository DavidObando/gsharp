// <copyright file="CSharpToGSharpTranslator.AsyncVoidHandlers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        // Issue #2438: G# has no distinct "async void" callable shape — EVERY
        // G# `async func` (method, local function, or lambda) is Task-observable
        // at its call site (gsc's `MethodGroupObservableReturnType` / the
        // matching lambda-natural-type rule), matching C# `async Task`. A
        // genuine C# `async void` handler (the ONLY C# shape with no awaitable
        // result at all — used for event handlers, since C# forbids awaiting an
        // async-void method) has no such Task to observe, so translating it
        // as an ordinary `async func` leaves its method-group/lambda value
        // typed `(args) -> Task`, which cannot convert to the `(args) -> void`
        // event-delegate shape the original C# subscribed with (GS0155).
        //
        // The fix is scoped EXACTLY to a Roslyn symbol whose `IsAsync &&
        // ReturnsVoid` is true (see <see cref="IsCSharpAsyncVoidHandler"/>) —
        // an ordinary `async Task`/`async Task&lt;T&gt;` method, local function, or
        // lambda keeps its existing (correct) Task-observable translation
        // unchanged, and a Task-returning method group still correctly FAILS
        // to convert to a void delegate (the negative control the issue calls
        // out: cs2gs must not globally discard arbitrary Tasks).
        //
        // For a genuine async-void handler, the translator emits a
        // NON-async, void-returning wrapper with the ORIGINAL name/identity
        // (so method-group `+=`/`-=` subscription and unsubscription keep
        // referring to the SAME symbol/value) whose body:
        //   1. binds the untouched original body to a nested `async func`
        //      value (so its own awaits/exception flow are lowered exactly
        //      like any other G# async function — no new async semantics are
        //      invented),
        //   2. invokes it immediately with the wrapper's own parameters
        //      (kicks off synchronously up to the first incomplete `await`,
        //      matching C#'s async-void semantics: the call returns void as
        //      soon as the state machine yields or completes), and
        //   3. attaches a fire-and-forget continuation that surfaces any
        //      unobserved fault the same way the real
        //      `AsyncVoidMethodBuilder` does: posted through the
        //      `SynchronizationContext.Current` CAPTURED SYNCHRONOUSLY AT
        //      THE HANDLER'S OWN ENTRY (before the nested async body is
        //      even invoked — exactly when `AsyncVoidMethodBuilder.Create()`
        //      captures it) when one was set (so a UI handler's exception
        //      reaches the same context a real C# async-void handler would
        //      notify), or queued onto a bare `ThreadPool` work item
        //      otherwise (a genuinely unhandled exception on that worker
        //      thread crashes the process — matching the no-context C#
        //      async-void behavior, and NOT the same as an inline `throw`
        //      inside the `ContinueWith` continuation itself, which would
        //      merely fault the continuation's own unobserved Task and be
        //      silently dropped) — so the fault is never silently swallowed.
        //
        // Remaining, unavoidable semantic difference vs. real C# `async
        // void`: the real `AsyncVoidMethodBuilder` throws directly on the
        // ORIGINAL calling thread's stack when there is no context AND that
        // stack is still live (synchronous-completion fast path); this
        // wrapper always defers even a same-thread synchronous fault to a
        // continuation, so a caller can never catch it with a surrounding
        // `try`/`catch` at the subscription/raise call site — matching real
        // async void's documented advice that a caller must never rely on
        // catching an async-void handler's exceptions locally at all.
        private static bool IsCSharpAsyncVoidHandler(IMethodSymbol symbol)
            => symbol is { IsAsync: true, ReturnsVoid: true };

        /// <summary>
        /// Builds the fire-and-forget wrapper body described above. The
        /// returned block is meant to become the ENTIRE (non-async, void)
        /// body of the translated handler — <paramref name="originalAsyncBody"/>
        /// (the handler's own, otherwise-unmodified translated body) becomes
        /// the block body of a nested <c>async func</c> literal that the
        /// wrapper invokes and observes.
        /// </summary>
        /// <param name="parameters">The handler's own parameter list (reused verbatim for the nested async literal and the forwarding call).</param>
        /// <param name="originalAsyncBody">The handler's untouched translated body.</param>
        /// <param name="location">A source location used to resolve/import the well-known BCL types the wrapper references.</param>
        private BlockStatement BuildAsyncVoidHandlerWrapperBody(
            IReadOnlyList<Parameter> parameters,
            BlockStatement originalAsyncBody,
            Location location)
        {
            const string bodyLocalName = "__gsAsyncVoidBody";
            const string taskParamName = "__gsAsyncVoidTask";
            const string exceptionLocalName = "__gsAsyncVoidEx";
            const string contextLocalName = "__gsAsyncVoidCtx";
            const string postStateParamName = "__gsAsyncVoidState";

            string taskTypeName = this.ResolveWellKnownTypeName("System.Threading.Tasks.Task", location, "Task");
            string syncContextTypeName = this.ResolveWellKnownTypeName("System.Threading.SynchronizationContext", location, "SynchronizationContext");
            string continuationOptionsTypeName = this.ResolveWellKnownTypeName("System.Threading.Tasks.TaskContinuationOptions", location, "TaskContinuationOptions");
            string threadPoolTypeName = this.ResolveWellKnownTypeName("System.Threading.ThreadPool", location, "ThreadPool");

            // let __gsAsyncVoidCtx = SynchronizationContext.Current
            //
            // Captured HERE, synchronously, BEFORE the nested async literal
            // below is ever invoked — exactly mirroring the real
            // `AsyncVoidMethodBuilder.Create()`, which captures the ambient
            // context once at the handler's own entry, before its first
            // `await`. Reading `SynchronizationContext.Current` later,
            // inside the `ContinueWith` continuation below, would instead
            // observe whatever thread happens to run the fault continuation
            // (usually a bare thread-pool worker with no context at all),
            // which is NOT what a real async-void handler captures.
            var captureContextDeclaration = new LocalDeclarationStatement(
                BindingKind.Let,
                contextLocalName,
                type: new NamedTypeReference(syncContextTypeName) { IsNullable = true },
                initializer: new MemberAccessExpression(new IdentifierExpression(syncContextTypeName), "Current"));

            // let __gsAsyncVoidBody = async (params) -> { <original body> }
            var bodyDeclaration = new LocalDeclarationStatement(
                BindingKind.Let,
                bodyLocalName,
                initializer: new LambdaExpression(
                    parameters,
                    blockBody: originalAsyncBody,
                    isAsync: true,
                    isFunctionLiteral: true));

            List<GExpression> forwardedArguments = parameters
                .Select(p => (GExpression)new IdentifierExpression(p.Name))
                .ToList();

            // __gsAsyncVoidEx = __gsAsyncVoidTask.Exception!!.InnerException!!
            GExpression exceptionInitializer = new NonNullAssertionExpression(
                new MemberAccessExpression(
                    new NonNullAssertionExpression(
                        new MemberAccessExpression(new IdentifierExpression(taskParamName), "Exception")),
                    "InnerException"));

            // (state object) -> { throw __gsAsyncVoidEx }
            var rethrowCallback = new LambdaExpression(
                new List<Parameter> { new Parameter(postStateParamName, new NamedTypeReference("object")) },
                blockBody: new BlockStatement(new GStatement[]
                {
                    new ThrowStatement(new IdentifierExpression(exceptionLocalName)),
                }));

            // No ambient context (the common console-app/background-thread
            // case): queue the rethrow on a bare thread-pool work item — NOT
            // an inline `throw` right here, which would only fault the
            // (unobserved, silently-dropped) Task that `ContinueWith` itself
            // returns. A raw `ThreadPool.QueueUserWorkItem` callback that
            // throws is a genuinely unhandled exception on that worker
            // thread, matching real async-void's crash-the-process behavior
            // when there is no context to post to (mirrors the real
            // `AsyncVoidMethodBuilder`'s own `ThreadPool.QueueUserWorkItem`
            // fallback in `AsyncMethodBuilderCore.ThrowAsync`).
            var elseBranch = new BlockStatement(new GStatement[]
            {
                new ExpressionStatement(new InvocationExpression(
                    new MemberAccessExpression(new IdentifierExpression(threadPoolTypeName), "QueueUserWorkItem"),
                    new List<GExpression> { rethrowCallback })),
            });

            var ifContextPresent = new IfStatement(
                new BinaryExpression(new IdentifierExpression(contextLocalName), "!=", LiteralExpression.Null()),
                new BlockStatement(new GStatement[]
                {
                    new ExpressionStatement(new InvocationExpression(
                        new MemberAccessExpression(
                            new NonNullAssertionExpression(new IdentifierExpression(contextLocalName)),
                            "Post"),
                        new List<GExpression> { rethrowCallback, LiteralExpression.Null() })),
                }),
                elseBranch);

            var faultedBranch = new BlockStatement(new GStatement[]
            {
                new LocalDeclarationStatement(BindingKind.Let, exceptionLocalName, initializer: exceptionInitializer),
                ifContextPresent,
            });

            var continuationBody = new BlockStatement(new GStatement[]
            {
                new IfStatement(
                    new MemberAccessExpression(new IdentifierExpression(taskParamName), "IsFaulted"),
                    faultedBranch),
            });

            var continuationLambda = new LambdaExpression(
                new List<Parameter> { new Parameter(taskParamName, new NamedTypeReference(taskTypeName)) },
                blockBody: continuationBody);

            GExpression continuationOptions = new BinaryExpression(
                new MemberAccessExpression(new IdentifierExpression(continuationOptionsTypeName), "OnlyOnFaulted"),
                "|",
                new MemberAccessExpression(new IdentifierExpression(continuationOptionsTypeName), "ExecuteSynchronously"));

            // __gsAsyncVoidBody(args).ContinueWith((t) -> { ... }, OnlyOnFaulted | ExecuteSynchronously)
            var continueWithCall = new ExpressionStatement(new InvocationExpression(
                new MemberAccessExpression(
                    new InvocationExpression(new IdentifierExpression(bodyLocalName), forwardedArguments),
                    "ContinueWith"),
                new List<GExpression> { continuationLambda, continuationOptions }));

            return new BlockStatement(new GStatement[] { captureContextDeclaration, bodyDeclaration, continueWithCall });
        }

        /// <summary>
        /// Resolves <paramref name="metadataName"/> through the real type
        /// mapper (so the reference is shortened AND its namespace is
        /// registered for auto-import, ADR-0115 §B.7/issue #2211) when the
        /// compilation can see the type; falls back to
        /// <paramref name="fallbackName"/> (fully qualifying nothing) only if
        /// the well-known BCL type is somehow unavailable, which should not
        /// happen for any real corpus referencing events/async at all.
        /// </summary>
        private string ResolveWellKnownTypeName(string metadataName, Location location, string fallbackName)
        {
            INamedTypeSymbol symbol = this.context.Compilation.GetTypeByMetadataName(metadataName);
            if (symbol is null)
            {
                return fallbackName;
            }

            return this.typeMapper.Map(symbol, this.context, location) is NamedTypeReference named
                ? named.Name
                : fallbackName;
        }
    }
}
