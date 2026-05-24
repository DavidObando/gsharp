// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OmniSharp.Extensions.LanguageServer.Server;
using LanguageServerHost = OmniSharp.Extensions.LanguageServer.Server.LanguageServer;

namespace GSharp.LanguageServer;

/// <summary>
/// GSharp Language Server.
/// </summary>
public class Program
{
    /// <summary>
    /// Entry point for GSharp LanguageServer.
    /// </summary>
    /// <param name="args">Command line arguments.</param>
    /// <returns>A <see cref="Task"/> representing the asynchronous operation.</returns>
    public static async Task Main(string[] args)
    {
        var server = await LanguageServerHost.From(options =>
            options
                .WithInput(Console.OpenStandardInput())
                .WithOutput(Console.OpenStandardOutput())
                .ConfigureLogging(builder => builder.SetMinimumLevel(LogLevel.Trace))
                .WithServices(ConfigureServices)
                .WithHandler<DocumentSyncHandler>()
                .WithHandler<FoldingHandler>()
                .WithHandler<HoverHandler>()
                .WithHandler<ReferencesHandler>()
                .WithHandler<RenameHandler>()
                .WithHandler<CodeActionHandler>());

        await server.WaitForExit;
    }

    private static void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<DocumentContentService>();
    }
}
