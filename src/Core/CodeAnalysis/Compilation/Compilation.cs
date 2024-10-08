﻿// <copyright file="Compilation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Compilation
{
    using System;
    using System.Collections.Generic;
    using System.Collections.Immutable;
    using System.IO;
    using System.Linq;
    using System.Reflection.Metadata;
    using System.Reflection.Metadata.Ecma335;
    using System.Reflection.PortableExecutable;
    using System.Threading;
    using GSharp.Core.CodeAnalysis.Binding;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.CodeAnalysis.Text;
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
        /// <param name="syntaxTrees">The syntax trees.</param>
        public Compilation(params SyntaxTree[] syntaxTrees)
            : this(null, syntaxTrees)
        {
        }

        private Compilation(Compilation previous, SyntaxTree[] syntaxTrees)
        {
            Previous = previous;
            SyntaxTrees = syntaxTrees.ToImmutableArray();
        }

        /// <summary>
        /// Gets the previous compilation.
        /// </summary>
        public Compilation Previous { get; }

        /// <summary>
        /// Gets the syntax trees.
        /// </summary>
        public ImmutableArray<SyntaxTree> SyntaxTrees { get; }

        /// <summary>
        /// Gets the global scope.
        /// </summary>
        public BoundGlobalScope GlobalScope
        {
            get
            {
                if (globalScope == null)
                {
                    var globalScope = Binder.BindGlobalScope(Previous?.GlobalScope, SyntaxTrees);
                    Interlocked.CompareExchange(ref this.globalScope, globalScope, null);
                }

                return globalScope;
            }
        }

        /// <summary>
        /// Continue the compilation with the specified syntax tree chained to the
        /// current compilation.
        /// </summary>
        /// <param name="syntaxTrees">The new syntax trees.</param>
        /// <returns>The chained compilation.</returns>
        public Compilation ContinueWith(params SyntaxTree[] syntaxTrees)
        {
            return new Compilation(this, syntaxTrees);
        }

        /// <summary>
        /// Evaluates the current compilation provided a symbol table with actual values.
        /// </summary>
        /// <param name="variables">The symbol table with actual values.</param>
        /// <returns>An evaluation result.</returns>
        public EvaluationResult Evaluate(Dictionary<VariableSymbol, object> variables)
        {
            var parseDiagnostics = SyntaxTrees.SelectMany(st => st.Diagnostics);
            var diagnostics = parseDiagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();
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
            try
            {
                var value = evaluator.Evaluate();
                return new EvaluationResult(ImmutableArray<Diagnostic>.Empty, value);
            }
            catch (EvaluatorException ex)
            {
                using var textWriter = new StringWriter();
                ex.Node?.WriteTo(textWriter);
                var sourceText = SourceText.From(textWriter.ToString());
                var location = new TextLocation(sourceText, new TextSpan(0, sourceText.Length));
                var message = ex.Message;
                var diagnostic = new Diagnostic(location, message);
                return new EvaluationResult(ImmutableArray.Create(diagnostic), null);
            }
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
            var parseDiagnostics = SyntaxTrees.SelectMany(st => st.Diagnostics);
            var syntaxDiagnostics = parseDiagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();
            if (syntaxDiagnostics.Any())
            {
                return new EmitResult(success: false, syntaxDiagnostics);
            }

            var program = Binder.BindProgram(GlobalScope);
            if (program.Diagnostics.Any())
            {
                return new EmitResult(success: false, program.Diagnostics.ToImmutableArray());
            }

            var emitDiagnostics = EmitAssembly(program);
            if (emitDiagnostics.Any())
            {
                return new EmitResult(success: false, emitDiagnostics);
            }

            return new EmitResult(success: true, diagnostics: ImmutableArray<Diagnostic>.Empty);
        }

        private ImmutableArray<Diagnostic> EmitAssembly(BoundProgram program)
        {
            var header = new PEHeaderBuilder();
            var metadataBuilder = new MetadataBuilder();
            var metadataRootBuilder = new MetadataRootBuilder(metadataBuilder);
            var blobBuilder = new BlobBuilder();
            var peBuilder = new ManagedPEBuilder(header, metadataRootBuilder, blobBuilder);
            peBuilder.Serialize(blobBuilder);

            // TODO: Produce portable assembly contents here
            using (var stream = new StreamWriter(program.PackageName + ".dll"))
            {
                blobBuilder.WriteContentTo(stream.BaseStream);
            }

            return ImmutableArray<Diagnostic>.Empty;
        }
    }
}
