// <copyright file="FormattingHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;
using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Document;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using OmniSharp.Extensions.LanguageServer.Protocol.Window;

namespace GSharp.LanguageServer;

/// <summary>
/// Document formatting handler — formats the entire document.
/// </summary>
public class FormattingHandler : DocumentFormattingHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="FormattingHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public FormattingHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<TextEditContainer> Handle(DocumentFormattingParams request, CancellationToken cancellationToken)
    {
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new TextEditContainer());
        }

        var sourceText = content.SyntaxTree.Text;
        var originalText = sourceText.ToString();
        var formatted = FormattingEngine.Format(originalText);

        if (formatted == originalText)
        {
            return Task.FromResult(new TextEditContainer());
        }

        var lastLine = sourceText.Lines.Length - 1;
        var lastChar = sourceText.Lines[lastLine].Length;

        var edit = new TextEdit
        {
            Range = new OmniSharp.Extensions.LanguageServer.Protocol.Models.Range(
                new Position(0, 0),
                new Position(lastLine, lastChar)),
            NewText = formatted,
        };

        return Task.FromResult(new TextEditContainer(edit));
    }

    /// <inheritdoc/>
    protected override DocumentFormattingRegistrationOptions CreateRegistrationOptions(DocumentFormattingCapability capability, ClientCapabilities clientCapabilities)
    {
        return new DocumentFormattingRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
        };
    }
}

/// <summary>
/// Range formatting handler — formats a selection.
/// </summary>
public class RangeFormattingHandler : DocumentRangeFormattingHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="RangeFormattingHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public RangeFormattingHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<TextEditContainer> Handle(DocumentRangeFormattingParams request, CancellationToken cancellationToken)
    {
        // For simplicity, format the entire document (range formatting with partial re-formatting
        // is complex without a trivia model)
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new TextEditContainer());
        }

        var sourceText = content.SyntaxTree.Text;
        var originalText = sourceText.ToString();
        var formatted = FormattingEngine.Format(originalText);

        if (formatted == originalText)
        {
            return Task.FromResult(new TextEditContainer());
        }

        var lastLine = sourceText.Lines.Length - 1;
        var lastChar = sourceText.Lines[lastLine].Length;

        var edit = new TextEdit
        {
            Range = new OmniSharp.Extensions.LanguageServer.Protocol.Models.Range(
                new Position(0, 0),
                new Position(lastLine, lastChar)),
            NewText = formatted,
        };

        return Task.FromResult(new TextEditContainer(edit));
    }

    /// <inheritdoc/>
    protected override DocumentRangeFormattingRegistrationOptions CreateRegistrationOptions(DocumentRangeFormattingCapability capability, ClientCapabilities clientCapabilities)
    {
        return new DocumentRangeFormattingRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
        };
    }
}

/// <summary>
/// On-type formatting handler — formats on `;`, `}`, and newline.
/// </summary>
public class OnTypeFormattingHandler : DocumentOnTypeFormattingHandlerBase
{
    private readonly ILanguageServerFacade router;
    private readonly DocumentContentService documentContentService;

    /// <summary>
    /// Initializes a new instance of the <see cref="OnTypeFormattingHandler"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="documentContentService"><see cref="DocumentContentService"/> instance.</param>
    public OnTypeFormattingHandler(ILanguageServerFacade router, DocumentContentService documentContentService)
    {
        this.router = router;
        this.documentContentService = documentContentService;
    }

    /// <inheritdoc/>
    public override Task<TextEditContainer> Handle(DocumentOnTypeFormattingParams request, CancellationToken cancellationToken)
    {
        // On-type formatting: format the entire document for consistency
        var key = request.TextDocument.Uri.ToString();
        if (!this.documentContentService.TryGet(key, out DocumentContent content))
        {
            this.router.Window.LogWarning($"No syntax tree for {key}");
            return Task.FromResult(new TextEditContainer());
        }

        var sourceText = content.SyntaxTree.Text;
        var originalText = sourceText.ToString();
        var formatted = FormattingEngine.Format(originalText);

        if (formatted == originalText)
        {
            return Task.FromResult(new TextEditContainer());
        }

        var lastLine = sourceText.Lines.Length - 1;
        var lastChar = sourceText.Lines[lastLine].Length;

        var edit = new TextEdit
        {
            Range = new OmniSharp.Extensions.LanguageServer.Protocol.Models.Range(
                new Position(0, 0),
                new Position(lastLine, lastChar)),
            NewText = formatted,
        };

        return Task.FromResult(new TextEditContainer(edit));
    }

    /// <inheritdoc/>
    protected override DocumentOnTypeFormattingRegistrationOptions CreateRegistrationOptions(DocumentOnTypeFormattingCapability capability, ClientCapabilities clientCapabilities)
    {
        return new DocumentOnTypeFormattingRegistrationOptions
        {
            DocumentSelector = Constants.DocumentSelector,
            FirstTriggerCharacter = "}",
            MoreTriggerCharacter = new Container<string>(";", "\n"),
        };
    }
}
