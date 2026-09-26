using System.Text.RegularExpressions;

namespace Issue3086;

public sealed record GitHubUrl(string Owner, string Name, int? PrNumber)
{
    public static bool TryParse(string? url, out GitHubUrl parsed)
    {
        parsed = new GitHubUrl(string.Empty, string.Empty, null);
        if (string.IsNullOrWhiteSpace(url))
        {
            return false;
        }

        var match = GitHubUrlPatterns.Pattern().Match(url.Trim());
        if (!match.Success)
        {
            return false;
        }

        int? prNumber = match.Groups["pr"].Success ? int.Parse(match.Groups["pr"].Value) : null;
        parsed = new GitHubUrl(match.Groups["owner"].Value, match.Groups["name"].Value, prNumber);
        return true;
    }
}

// Issue #4301: a G# record cannot hold a partial func (GS0607), so the
// [GeneratedRegex] methods live in a partial class, which migrates to G#
// declaring parts that gsgen implements with the real Regex generator.
internal static partial class GitHubUrlPatterns
{
    private const string PatternText =
        @"^https://(www\.)?github\.com/(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/(?<name>[A-Za-z0-9._-]+?)(\.git)?(/(pull/(?<pr>\d+))?)?/?$";

    public static bool HasExpectedRegexSemantics()
    {
        Regex regex = Pattern();
        return regex.ToString() == PatternText &&
            regex.Options == RegexOptions.ExplicitCapture &&
            regex.MatchTimeout.TotalMilliseconds == 1000 &&
            object.ReferenceEquals(regex, Pattern());
    }

    public static bool HasDefaultRegexSemantics()
    {
        Regex defaultRegex = DefaultPattern();
        Regex infiniteRegex = InfinitePattern();
        return defaultRegex.ToString() == "^default$" &&
            defaultRegex.Options == RegexOptions.None &&
            defaultRegex.MatchTimeout.TotalMilliseconds == 250 &&
            object.ReferenceEquals(defaultRegex, DefaultPattern()) &&
            infiniteRegex.MatchTimeout == Regex.InfiniteMatchTimeout &&
            object.ReferenceEquals(infiniteRegex, InfinitePattern());
    }

    public static bool HasInvariantInlineIgnoreCaseSemantics()
    {
        Regex regex = InvariantPattern();
        return regex.IsMatch("INVARIANT") &&
            regex.Options == RegexOptions.CultureInvariant &&
            object.ReferenceEquals(regex, InvariantPattern());
    }

    [GeneratedRegex(
        PatternText,
        RegexOptions.ExplicitCapture,
        matchTimeoutMilliseconds: 1000)]
    internal static partial Regex Pattern();

    [GeneratedRegex("^default$")]
    private static partial Regex DefaultPattern();

    [GeneratedRegex("^infinite$", RegexOptions.None, matchTimeoutMilliseconds: -1)]
    private static partial Regex InfinitePattern();

    [GeneratedRegex("(?i)^invariant$", RegexOptions.CultureInvariant)]
    private static partial Regex InvariantPattern();

    // Culture-sensitive IgnoreCase, which the pre-#4301 cached-Regex rewrite
    // could not migrate: under tr-TR, `i` matches dotted `\u0130` but not `I`.
    public static bool HasCultureSemantics() =>
        TurkishI().IsMatch("\u0130") && !TurkishI().IsMatch("I") && InlineIgnoreCase().IsMatch("ABC");

    [GeneratedRegex("^i$", RegexOptions.IgnoreCase, "tr-TR")]
    private static partial Regex TurkishI();

    [GeneratedRegex("(?i)^abc$")]
    private static partial Regex InlineIgnoreCase();
}

public sealed partial class InstanceRegexOwner
{
    [GeneratedRegex("^[a-z]+$")]
    public partial Regex LowercaseWords();
}

public static class Program
{
    public static void Main()
    {
        AppContext.SetData("REGEX_DEFAULT_MATCH_TIMEOUT", TimeSpan.FromMilliseconds(250));

        AssertUrl("https://github.com/DavidObando/gsharp", null);
        AssertUrl("https://github.com/DavidObando/gsharp/pull/3086", 3086);

        if (!GitHubUrlPatterns.HasExpectedRegexSemantics())
        {
            throw new InvalidOperationException("GeneratedRegex semantics changed.");
        }

        if (!GitHubUrlPatterns.HasDefaultRegexSemantics() ||
            !GitHubUrlPatterns.HasInvariantInlineIgnoreCaseSemantics() ||
            !GitHubUrlPatterns.HasCultureSemantics())
        {
            throw new InvalidOperationException("GeneratedRegex default semantics changed.");
        }

        var firstOwner = new InstanceRegexOwner();
        var secondOwner = new InstanceRegexOwner();
        Regex firstRegex = firstOwner.LowercaseWords();
        if (!firstRegex.IsMatch("lowercase") ||
            firstRegex.IsMatch("UPPERCASE") ||
            !object.ReferenceEquals(firstRegex, firstOwner.LowercaseWords()) ||
            !object.ReferenceEquals(firstRegex, secondOwner.LowercaseWords()))
        {
            throw new InvalidOperationException("GeneratedRegex instance lowering changed.");
        }

        Console.WriteLine("repository+pull-request+regex-ok");
    }

    private static void AssertUrl(string url, int? expectedPullRequest)
    {
        if (!GitHubUrl.TryParse(url, out GitHubUrl parsed) ||
            parsed.Owner != "DavidObando" ||
            parsed.Name != "gsharp" ||
            parsed.PrNumber != expectedPullRequest)
        {
            throw new InvalidOperationException("GitHub URL parse failed: " + url);
        }
    }
}
