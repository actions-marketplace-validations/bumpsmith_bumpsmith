from pydantic import BaseSettings


class Settings(BaseSettings):
    app_name: str = "demo"
    debug: bool = False


def load() -> Settings:
    return Settings()
