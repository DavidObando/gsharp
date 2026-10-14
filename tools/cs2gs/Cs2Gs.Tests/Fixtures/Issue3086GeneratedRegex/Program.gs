package Issue3086

import System
import System.Text.RegularExpressions

partial data class GitHubUrl(Owner string, Name string, PrNumber int32?) : IEquatable[GitHubUrl] {
    shared {
        private const PatternText string = "^https://(www\\.)?github\\.com/(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/(?<name>[A-Za-z0-9._-]+?)(\\.git)?(/(pull/(?<pr>\\d+))?)?/?$$"

        func TryParse(url string?, out parsed GitHubUrl) bool {
            parsed = GitHubUrl(string.Empty, string.Empty, nil)
            if string.IsNullOrWhiteSpace(url) {
                return false
            }
            let match = Pattern().Match(url.Trim())
            if !match.Success {
                return false
            }
            let prNumber int32? = if match.Groups["pr"].Success {
                int32.Parse(match.Groups["pr"].Value)
            } else {
                nil
            }
            parsed = GitHubUrl(match.Groups["owner"].Value, match.Groups["name"].Value, prNumber)
            return true
        }

        func HasExpectedRegexSemantics() bool {
            let regex = Pattern()
            return regex.ToString() == PatternText &&
                regex.Options == RegexOptions.ExplicitCapture &&
                regex
                .MatchTimeout
                .TotalMilliseconds == float64(1000.0) &&
                object.ReferenceEquals(regex, Pattern())
        }

        func HasDefaultRegexSemantics() bool {
            let defaultRegex = DefaultPattern()
            let infiniteRegex = InfinitePattern()
            return defaultRegex.ToString() == "^default$$" &&
                defaultRegex.Options == RegexOptions.None &&
                defaultRegex
                .MatchTimeout
                .TotalMilliseconds == float64(250.0) &&
                object.ReferenceEquals(defaultRegex, DefaultPattern()) &&
                infiniteRegex.MatchTimeout == Regex.InfiniteMatchTimeout &&
                object.ReferenceEquals(infiniteRegex, InfinitePattern())
        }

        func HasInvariantInlineIgnoreCaseSemantics() bool {
            let regex = InvariantPattern()
            return regex.IsMatch("INVARIANT") &&
                regex.Options == RegexOptions.CultureInvariant &&
                object.ReferenceEquals(regex, InvariantPattern())
        }

        @GeneratedRegex(
            "^https://(www\\.)?github\\.com/(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/(?<name>[A-Za-z0-9._-]+?)(\\.git)?(/(pull/(?<pr>\\d+))?)?/?$$",
            RegexOptions.ExplicitCapture,
            1000
        )
        private partial func Pattern() Regex;

        @GeneratedRegex("^default$$")
        private partial func DefaultPattern() Regex;

        @GeneratedRegex("^infinite$$", RegexOptions.None, -1)
        private partial func InfinitePattern() Regex;

        @GeneratedRegex("(?i)^invariant$$", RegexOptions.CultureInvariant)
        private partial func InvariantPattern() Regex;

        // Culture-sensitive IgnoreCase, which the pre-#4301 cached-Regex rewrite
        // could not migrate: under tr-TR, `i` matches dotted `\u0130` but not `I`.
        func HasCultureSemantics() bool -> TurkishI().IsMatch("İ") && !TurkishI().IsMatch("I") &&
            InlineIgnoreCase().IsMatch("ABC")

        @GeneratedRegex("^i$$", RegexOptions.IgnoreCase, "tr-TR")
        private partial func TurkishI() Regex;

        @GeneratedRegex("(?i)^abc$$")
        private partial func InlineIgnoreCase() Regex;
    }
}

partial class InstanceRegexOwner {
    @GeneratedRegex("^[a-z]+$$")
    partial func LowercaseWords() Regex;
}

private func AssertUrl(url string, expectedPullRequest int32?) {
    if !GitHubUrl.TryParse(url, out var parsed) ||
        parsed.Owner != "DavidObando" ||
        parsed.Name != "gsharp" ||
        parsed.PrNumber != expectedPullRequest {
        throw InvalidOperationException("GitHub URL parse failed: " + url)
    }
}

AppContext.SetData("REGEX_DEFAULT_MATCH_TIMEOUT", TimeSpan.FromMilliseconds(250))
AssertUrl("https://github.com/DavidObando/gsharp", nil)
AssertUrl("https://github.com/DavidObando/gsharp/pull/3086", 3086)

if !GitHubUrl.HasExpectedRegexSemantics() {
    throw InvalidOperationException("GeneratedRegex semantics changed.")
}

if !GitHubUrl.HasDefaultRegexSemantics() || !GitHubUrl.HasInvariantInlineIgnoreCaseSemantics() ||
    !GitHubUrl.HasCultureSemantics() {
    throw InvalidOperationException("GeneratedRegex default semantics changed.")
}

let firstOwner = InstanceRegexOwner()
let secondOwner = InstanceRegexOwner()
let firstRegex = firstOwner.LowercaseWords()

if !firstRegex.IsMatch("lowercase") || firstRegex.IsMatch("UPPERCASE") || !object.ReferenceEquals(
    firstRegex,
    firstOwner.LowercaseWords()
) ||
    !object
    .ReferenceEquals(firstRegex, secondOwner.LowercaseWords()) {
    throw InvalidOperationException("GeneratedRegex instance lowering changed.")
}

Console.WriteLine("repository+pull-request+regex-ok")
