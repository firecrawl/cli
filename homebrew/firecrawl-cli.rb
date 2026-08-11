class FirecrawlCli < Formula
  desc "CLI for Firecrawl - web scraping, web and paper search, browser automation"
  homepage "https://firecrawl.dev"
  version "1.10.0"
  license "ISC"

  on_macos do
    on_arm do
      url "https://github.com/firecrawl/cli/releases/download/v#{version}/firecrawl-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER"
    end
    on_intel do
      url "https://github.com/firecrawl/cli/releases/download/v#{version}/firecrawl-darwin-x64.tar.gz"
      sha256 "PLACEHOLDER"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/firecrawl/cli/releases/download/v#{version}/firecrawl-linux-arm64.tar.gz"
      sha256 "PLACEHOLDER"
    end
    on_intel do
      url "https://github.com/firecrawl/cli/releases/download/v#{version}/firecrawl-linux-x64.tar.gz"
      sha256 "PLACEHOLDER"
    end
  end

  def install
    if OS.mac?
      if Hardware::CPU.arm?
        bin.install "firecrawl-darwin-arm64" => "firecrawl"
      else
        bin.install "firecrawl-darwin-x64" => "firecrawl"
      end
    elsif OS.linux?
      if Hardware::CPU.arm?
        bin.install "firecrawl-linux-arm64" => "firecrawl"
      else
        bin.install "firecrawl-linux-x64" => "firecrawl"
      end
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/firecrawl --version")
  end
end
