// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.LSP
{
    using System;
    using System.Threading.Tasks;
    using Microsoft.Extensions.DependencyInjection;
    using Microsoft.Extensions.Logging;
    using OmniSharp.Extensions.LanguageServer.Server;

    /// <summary>
    /// GSharp Language Server.
    /// </summary>
    public class Program
    {
        /// <summary>
        /// Entry point for GSharp LSP.
        /// </summary>
        /// <param name="args">Command line arguments.</param>
        /// <returns>A <see cref="Task"/> representing the asynchronous operation.</returns>
        public static async Task Main(string[] args)
        {
            var server = await LanguageServer.From(options =>
                options
                    .WithInput(Console.OpenStandardInput())
                    .WithOutput(Console.OpenStandardOutput())
                    .WithLoggerFactory(new LoggerFactory())
                    .AddDefaultLoggingProvider()
                    .WithMinimumLogLevel(LogLevel.Trace)
                    .WithHandler<DocumentValidationHandler>());

            await server.WaitForExit;
        }
    }
}
