// <copyright file="Compilation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Compilation
{
    using System;
    using System.Collections.Generic;
    using System.Collections.Immutable;
    using System.Diagnostics;
    using System.IO;
    using System.Linq;
    using System.Reflection.Metadata;
    using System.Reflection.Metadata.Ecma335;
    using System.Reflection.PortableExecutable;
    using System.Threading;
    using GSharp.Core.CodeAnalysis.Binding;
    using GSharp.Core.CodeAnalysis.CodeGen;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;
    using Binder = GSharp.Core.CodeAnalysis.Binding.Binder;

    /// <summary>
    /// Chained compilation facilities.
    /// </summary>
    public class Compilation
    {
        private BoundGlobalScope globalScope;

        /// <summary>
        /// Initializes a new instance of the <see cref="Compilation"/> class.
        /// </summary>
        /// <param name="syntaxTree">The syntax tree.</param>
        public Compilation(SyntaxTree syntaxTree)
            : this(null, syntaxTree)
        {
        }

        private Compilation(Compilation previous, SyntaxTree syntaxTree)
        {
            Previous = previous;
            SyntaxTree = syntaxTree;
        }

        /// <summary>
        /// Gets the previous compilation.
        /// </summary>
        public Compilation Previous { get; }

        /// <summary>
        /// Gets the syntax tree.
        /// </summary>
        public SyntaxTree SyntaxTree { get; }

        /// <summary>
        /// Gets the global scope.
        /// </summary>
        internal BoundGlobalScope GlobalScope
        {
            get
            {
                if (globalScope == null)
                {
                    var globalScope = Binder.BindGlobalScope(Previous?.GlobalScope, SyntaxTree.Root);
                    Interlocked.CompareExchange(ref this.globalScope, globalScope, null);
                }

                return globalScope;
            }
        }

        /// <summary>
        /// Continue the compilation with the specified syntax tree chained to the
        /// current compilation.
        /// </summary>
        /// <param name="syntaxTree">The new syntax tree.</param>
        /// <returns>The chained compilation.</returns>
        public Compilation ContinueWith(SyntaxTree syntaxTree)
        {
            return new Compilation(this, syntaxTree);
        }

        /// <summary>
        /// Evaluates the current compilation provided a symbol table with actual values.
        /// </summary>
        /// <param name="variables">The symbol table with actual values.</param>
        /// <returns>An evaluation result.</returns>
        public EvaluationResult Evaluate(Dictionary<VariableSymbol, object> variables)
        {
            var diagnostics = SyntaxTree.Diagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();
            if (diagnostics.Any())
            {
                return new EvaluationResult(diagnostics, null);
            }

            var program = Binder.BindProgram(GlobalScope);

            var appPath = Environment.GetCommandLineArgs()[0];
            var appDirectory = Path.GetDirectoryName(appPath);
            var cfgPath = Path.Combine(appDirectory, "cfg.dot");
            var cfgStatement = !program.Statement.Statements.Any() && program.Functions.Any()
                                  ? program.Functions.Last().Value
                                  : program.Statement;
            var cfg = ControlFlowGraph.Create(cfgStatement);
            using (var streamWriter = new StreamWriter(cfgPath))
            {
                cfg.WriteTo(streamWriter);
            }

            if (program.Diagnostics.Any())
            {
                return new EvaluationResult(program.Diagnostics.ToImmutableArray(), null);
            }

            var evaluator = new Evaluator(program, variables);
            var value = evaluator.Evaluate();
            return new EvaluationResult(ImmutableArray<Diagnostic>.Empty, value);
        }

        /// <summary>
        /// Emits a tree for this program to the specified writer.
        /// </summary>
        /// <param name="writer">The writer.</param>
        public void EmitTree(TextWriter writer)
        {
            var program = Binder.BindProgram(GlobalScope);

            if (program.Statement.Statements.Any())
            {
                program.Statement.WriteTo(writer);
            }
            else
            {
                foreach (var functionBody in program.Functions)
                {
                    if (!GlobalScope.Functions.Contains(functionBody.Key))
                    {
                        continue;
                    }

                    functionBody.Key.WriteTo(writer);
                    functionBody.Value.WriteTo(writer);
                }
            }
        }

        /// <summary>
        /// Compiles the current syntax tree into a compilation result.
        /// </summary>
        /// <returns>An emit result.</returns>
        public EmitResult Emit()
        {
            var diagnostics = SyntaxTree.Diagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();
            if (diagnostics.Any())
            {
                return new EmitResult(success: false, diagnostics);
            }

            var program = Binder.BindProgram(GlobalScope);

            if (program.Diagnostics.Any())
            {
                return new EmitResult(success: false, program.Diagnostics.ToImmutableArray());
            }

            // TODO: emit program assembly here
            var emitDiagnostics = EmitAssembly(program);
            return new EmitResult(success: true, diagnostics: ImmutableArray<Diagnostic>.Empty);
        }

        private ImmutableArray<Diagnostic> EmitAssembly(BoundProgram program)
        {
            var header = new PEHeaderBuilder();
            var metadataBuilder = new MetadataBuilder();
            var metadataRootBuilder = new MetadataRootBuilder(metadataBuilder);
            var blobBuilder = new BlobBuilder();
            var peBuilder = new ManagedPEBuilder(header, metadataRootBuilder, blobBuilder);

            var encoder = new MethodBodyStreamEncoder(blobBuilder);
            var instructionEncoder = default(InstructionEncoder);
            encoder.AddMethodBody(instructionEncoder);

            // encoder.AddMethodBody()
            peBuilder.Serialize(blobBuilder);
            using (var stream = new StreamWriter(program.PackageName + ".dll"))
            {
                blobBuilder.WriteContentTo(stream.BaseStream);
            }

            return ImmutableArray<Diagnostic>.Empty;
        }
    }
}
